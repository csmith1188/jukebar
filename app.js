// Initialize leaderboardLastReset on server start if not set
const express = require('express');
const session = require('express-session');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

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

app.use(session({
    secret: 'thisisasupersecretsigmaskibidikeyandihavethekeytotheuniversebutnobodywillknowabcdefghijklmnopqrstuvwxyz',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true on HTTPS in production
        httpOnly: true,
        sameSite: 'lax', // helps mitigate CSRF for top-level navigations
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

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
io.on('connection', (socket) => {
    //console.log('Client connected for queue sync');
    
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
    });
    
    // Handle queue actions from clients
    socket.on('requestQueueUpdate', () => {
        socket.emit('queueUpdate', queueManager.getCurrentState());
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
            ownerID: Number(process.env.OWNER_ID) || 4
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
            ownerID: Number(process.env.OWNER_ID) || 4
        });
    } catch (error) {
        res.send(error.message);
    }
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
    console.log(`Server listening at http://localhost:${port}`);
});

module.exports = { app, io, formbarSocket };
