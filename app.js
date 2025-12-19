// Initialize leaderboardLastReset on server start if not set
const express = require('express');
const session = require('express-session');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const db = require('./utils/database');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('leaderboardLastReset', Date.now());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const sessionMiddleware = session({
    secret: 'thisisasupersecretsigmaskibidikeyandihavethekeytotheuniversebutnobodywillknowabcdefghijklmnopqrstuvwxyz',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true on HTTPS in production
        httpOnly: true,
        sameSite: 'lax', // helps mitigate CSRF for top-level navigations
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
});

app.use(sessionMiddleware);

// Share session with socket.io
io.engine.use(sessionMiddleware);

const { isAuthenticated } = require('./middleware/auth');

const { router: authRoutes } = require('./routes/auth');
const spotifyRoutes = require('./routes/spotify');
const paymentRoutes = require('./routes/payment');
const { router: leaderboardRoutes, checkAndResetLeaderboard } = require('./routes/leaderboard');
const userRoutes = require('./routes/users');
const queueManager = require('./utils/queueManager');
const { setupFormbarSocket, getCurrentClassroom } = require('./routes/socket');

// Formbar Socket.IO connection
const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const API_KEY = process.env.API_KEY || '';

console.log('=== Formbar Configuration ===');
console.log('FORMBAR_ADDRESS:', FORMBAR_ADDRESS);
console.log('API_KEY present:', !!API_KEY);
console.log('API_KEY length:', API_KEY.length);
console.log('=============================');

const formbarSocket = ioClient(FORMBAR_ADDRESS, {
    extraHeaders: { api: API_KEY },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
});

console.log('Formbar socket client created, attempting connection...');

setupFormbarSocket(io, formbarSocket);

// WebSocket connection handling for queue sync
// Initialize VoteManager
const VoteManager = require('./utils/voteManager');
const voteManager = new VoteManager();

io.on('connection', (socket) => {
    //console.log('Client connected for queue sync');
    
    // Broadcast updated user count to all clients
    io.emit('userCount', io.engine.clientsCount);
    
    // Send active ban vote to newly connected user
    const activeVote = voteManager.getActiveVote();
    if (activeVote) {
        socket.emit('banVoteStarted', activeVote);
    }
    
    // Send current auxiliary permission to newly connected client
    const classroom = getCurrentClassroom();
    if (classroom && classroom.permissions && classroom.permissions.auxiliary) {
        const auxiliaryPermission = parseInt(classroom.permissions.auxiliary);
        console.log('Sending initial auxiliary permission to new client:', auxiliaryPermission);
        socket.emit('auxiliaryPermission', auxiliaryPermission);
    }
    
    // Add client to queue manager
    queueManager.addClient(socket);
    
    // Handle client disconnect
    socket.on('disconnect', () => {
        //console.log('Client disconnected from queue sync');
        queueManager.removeClient(socket);
        // Broadcast updated user count after disconnect
        io.emit('userCount', io.engine.clientsCount);
    });
    
    // Handle queue actions from clients
    socket.on('requestQueueUpdate', () => {
        socket.emit('queueUpdate', queueManager.getCurrentState());
    });

    // Handle ban vote initiation
    socket.on('initiateBanVote', async (data) => {
        try {
            const { trackUri, trackName, trackArtist, initiator } = data;
            const userId = socket.request?.session?.token?.id || socket.id;

            // Check if user is owner (bypass payment)
            const ownerId = Number(process.env.OWNER_ID);
            const isOwner = userId === ownerId;

            // Verify payment for non-owners
            if (!isOwner) {
                if (!socket.request?.session?.hasPaid) {
                    socket.emit('banVoteError', { error: 'Payment required to start a ban vote' });
                    return;
                }
                // Reset payment flag after verification
                socket.request.session.hasPaid = false;
                socket.request.session.save();
            }

            // Get online user count
            const onlineCount = io.engine.clientsCount;

            // Check minimum users requirement
            if (onlineCount < 5) {
                socket.emit('banVoteError', { error: 'At least 5 users must be online to start a ban vote' });
                return;
            }

            // Check if there's already an active vote
            if (voteManager.hasActiveVote()) {
                socket.emit('banVoteError', { error: 'Please wait for the current ban vote to complete before starting a new one' });
                return;
            }

            // Check if track is already banned
            const isBanned = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM banned_songs WHERE track_name = ? AND artist_name = ?', [trackName, trackArtist], (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                });
            });

            if (isBanned) {
                socket.emit('banVoteError', { error: 'This track is already banned' });
                return;
            }

            // Start the vote with expiration callback
            const voteId = `${trackUri}-${Date.now()}`;
            const voteData = voteManager.startBanVote(
                voteId,
                trackUri,
                trackName,
                trackArtist,
                userId,
                onlineCount,
                (expiredData) => {
                    if (expiredData.passed) {
                        console.log('Vote expired, broadcasting banVotePassed:', expiredData);
                        // Insert into banned_songs table
                        db.run(
                            'INSERT INTO banned_songs (track_name, artist_name) VALUES (?, ?)',
                            [expiredData.trackName, expiredData.trackArtist],
                            (err) => {
                                if (err) {
                                    console.error('Database insertion error (ban on expiration):', err);
                                } else {
                                    console.log('Successfully inserted ban into database (expiration)');
                                }
                            }
                        );
                        io.emit('banVotePassed', expiredData);
                    } else {
                        console.log('Vote expired, broadcasting banVoteFailed:', expiredData);
                        io.emit('banVoteFailed', expiredData);
                    }
                }
            );

            // Broadcast to all clients
            io.emit('banVoteStarted', {
                voteId,
                trackUri,
                trackName,
                trackArtist,
                initiator,
                initiatorId: userId,
                onlineCount: onlineCount,
                totalOnline: onlineCount,
                yesVotes: 1,
                noVotes: 0,
                expiresIn: voteData.expiresIn
            });
        } catch (error) {
            console.error('Error initiating ban vote:', error);
            socket.emit('banVoteError', { error: 'Failed to initiate ban vote' });
        }
    });

    // Handle vote casting
    socket.on('castBanVote', async (data) => {
        try {
            const { voteId, vote } = data;
            const userId = socket.request?.session?.token?.id || socket.id;
            const result = voteManager.castVote(voteId, userId, vote);

            if (result.error) {
                socket.emit('banVoteError', { error: result.error });
                return;
            }

            if (result.passed) {
                console.log('Vote passed! Broadcasting banVotePassed:', result);
                // Insert into banned_songs table
                try {
                    await new Promise((resolve, reject) => {
                        console.log('Inserting into banned_songs:', result.trackName, result.trackArtist);
                        db.run(
                            'INSERT INTO banned_songs (track_name, artist_name) VALUES (?, ?)',
                            [result.trackName, result.trackArtist],
                            (err) => {
                                if (err) {
                                    console.error('Database insertion error:', err);
                                    reject(err);
                                } else {
                                    console.log('Successfully inserted ban into database');
                                    resolve();
                                }
                            }
                        );
                    });
                } catch (dbError) {
                    console.error('Failed to insert ban into database:', dbError);
                }

                // Broadcast vote passed
                io.emit('banVotePassed', {
                    trackUri: result.trackUri,
                    trackName: result.trackName,
                    yesVotes: result.yesVotes,
                    noVotes: result.noVotes
                });
            } else if (result.failed) {
                // Broadcast vote failed
                console.log('Broadcasting banVoteFailed:', result);
                io.emit('banVoteFailed', {
                    trackName: result.trackName,
                    yesVotes: result.yesVotes,
                    noVotes: result.noVotes,
                    reason: result.reason
                });
            } else {
                // Broadcast vote update
                io.emit('banVoteUpdate', {
                    yesVotes: result.yesVotes,
                    noVotes: result.noVotes,
                    onlineCount: result.onlineCount,
                    totalOnline: result.onlineCount,
                    trackName: result.trackName
                });
            }
        } catch (error) {
            console.error('Error casting ban vote:', error);
            socket.emit('banVoteError', { error: 'Failed to cast vote' });
        }
    });
});

// Initialize Spotify queue on startup
if (process.env.SPOTIFY_CLIENT_ID) {
    const { spotifyApi } = require('./utils/spotify');
    
    // Initialize queue from Spotify on startup
    async function initializeQueue() {
        try {
            console.log('Initializing queue from Spotify...');
            await queueManager.initializeFromSpotify(spotifyApi);
            console.log('Queue initialization complete');
        } catch (error) {
            console.warn('Could not initialize queue from Spotify:', error.message);
        }
    }
    
    // Call initialization
    initializeQueue();
    
    // Periodic Spotify sync (every 5 seconds)
    setInterval(async () => {
        try {
            await queueManager.syncWithSpotify(spotifyApi);
        } catch (error) {
            console.error('Sync interval error (non-fatal):', error.message);
        }
    }, 5000);
}

// Main routes
app.get('/', isAuthenticated, (req, res) => {
    try {
        console.log('Session permission:', req.session.permission);
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            hasPaid: !!req.session.hasPaid,
            payment: req.session.payment || null,
            userPermission: req.session.permission || 2,
            ownerID: Number(process.env.OWNER_ID) || 4,
            songAmount: Number(process.env.SONG_AMOUNT) || 50,
            skipAmount: Number(process.env.SKIP_AMOUNT) || 100,
            skipShieldAmount: Number(process.env.SKIP_SHIELD) || 75,
            voteBanAmount: Number(process.env.VOTE_BAN_AMOUNT) || 500
        });
    } catch (error) {
        res.send(error.message);
    }
});

app.get('/spotify', isAuthenticated, (req, res) => {
    try {
        console.log('Session permission (spotify route):', req.session.permission);
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            hasPaid: !!req.session.hasPaid,
            payment: req.session.payment || null,
            userPermission: req.session.permission || 2,
            ownerID: Number(process.env.OWNER_ID) || 4,
            songAmount: Number(process.env.SONG_AMOUNT) || 50,
            skipAmount: Number(process.env.SKIP_AMOUNT) || 100,
            skipShieldAmount: Number(process.env.SKIP_SHIELD) || 75,
            voteBanAmount: Number(process.env.VOTE_BAN_AMOUNT) || 500
        });
    } catch (error) {
        res.send(error.message);
    }
});

// API endpoint to get online user count
app.get('/api/online-count', (req, res) => {
    const onlineCount = io.engine.clientsCount;
    res.json({ count: onlineCount });
});

// Debug endpoint to check Formbar connection status
app.get('/debug/formbar', isAuthenticated, (req, res) => {
    const { getCurrentClassroom } = require('./routes/socket');
    const classroom = getCurrentClassroom();
    
    res.json({
        connected: formbarSocket.connected,
        formbarAddress: FORMBAR_ADDRESS,
        hasApiKey: !!API_KEY,
        apiKeyLength: API_KEY.length,
        hasClassroom: !!classroom,
        classroom: classroom,
        socketId: formbarSocket.id,
        transport: formbarSocket.io ? formbarSocket.io.engine.transport.name : 'unknown'
    });
});

app.get('/leaderboard', isAuthenticated, (req, res) => {
    try {
        if (Date.now() - (req.app.get('leaderboardLastReset') || 0) > 6 * 24 * 60 * 60 * 1000) {
            checkAndResetLeaderboard(req.app);
        }
        res.render('leaderboard.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            userPermission: req.session.permission || null,
            resetDate: req.app.get('leaderboardLastReset'),
            ownerID: Number(process.env.OWNER_ID) || 4
        });
    }
    catch (error) {
        res.send(error.message);
    }
});

app.get('/teacher', isAuthenticated, (req, res) => {
    try {
        if (req.session.permission >= 4 || req.session.token?.id === Number(process.env.OWNER_ID)) {
            res.render('teacher.ejs', {
                user: req.session.user,
                userID: req.session.token?.id,
                userPermission: req.session.permission || null,
                ownerID: Number(process.env.OWNER_ID) || 4
            });
        } else {
            res.redirect('/');
        }
    } catch (error) {
        res.send(error.message);
    }
});

app.use('/', authRoutes);
app.use('/', spotifyRoutes);
app.use('/', paymentRoutes);
app.use('/', leaderboardRoutes);
app.use('/', userRoutes);

server.listen(port, async () => {
    io.disconnectSockets();
    console.log(`Server listening at http://localhost:${port}`);
});

module.exports = { app, io, formbarSocket };
