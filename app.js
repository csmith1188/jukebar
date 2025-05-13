const express = require("express");
const ejs = require("ejs");
const path = require("path");
const jwt = require('jsonwebtoken');
const session = require('express-session');
const fs = require('fs');
const https = require('https');
const http = require('http');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();


// Import modules
const { db } = require('./modules/db/database');
const { spotifyApi } = require('./modules/spotify/config');
const routes = require("./modules/routes");
const { addToSpotifyQueue, getQueuedSongs, removeSongFromQueue } = require('./modules/spotify/queue');

// Initialize express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware configuration
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
    secret: process.env.SESSION_SECRET || 'ThisIsTheSuperSigmerSecretKeyThatIsUsedToSignTheSessionIDNobodyWillEverGuessThisCauseItsSoLongAndImSigmaNowHeresARandomStringOfNumbersToMakeItEvenLonger123456789093784983749837498374987234987264928734629874629837612893746219873461298476123847962348976123487965213489762348972314875234987123648923714698123468231746198472364981723649812734698127346981723649',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Route to handle audio download and processing
app.post('/download-audio', async (req, res) => {
    const { videoUrl } = req.body;

    // Validate the YouTube URL
    if (!ytdl.validateURL(videoUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Generate a unique file name for the audio
    const outputFilePath = path.join(downloadsDir, `${Date.now()}.mp3`);

    try {
        // Fetch the audio stream and process it with ffmpeg
        const audioStream = ytdl(videoUrl, { quality: 'highestaudio' });

        ffmpeg(audioStream)
            .audioCodec('libmp3lame')
            .save(outputFilePath)
            .on('end', () => {
                console.log(`Audio file saved: ${outputFilePath}`);
                res.json({ audioFilePath: `/downloads/${path.basename(outputFilePath)}` });
            })
            .on('error', (err) => {
                console.error('Error processing audio:', err);
                res.status(500).json({ error: 'Failed to process audio' });
            });
    } catch (error) {
        console.error('Error downloading audio:', error);
        res.status(500).json({ error: 'Failed to download audio' });
    }
});

// Serve the downloads directory
app.use('/downloads', express.static(downloadsDir));


// Main routes
app.use('/', routes);

// Authentication routes
app.get('/login', async (req, res) => {
    if (req.query.token) {
        try {
            console.log("Received token:", req.query.token);

            // Decode the token
            const tokenData = jwt.decode(req.query.token);
            if (!tokenData) {
                throw new Error("Invalid or malformed token");
            }
            console.log("Decoded Token Data:", tokenData);

            const { username, permissions, classID, className, classPermissions } = tokenData;

            // Check if the user exists in the database
            console.log("Checking user in database...");
            const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
            console.log("User query result:", user);

            if (!user) {
                // Insert new user into the database
                console.log("Inserting new user into database...");
                await db.run('INSERT INTO users (username) VALUES (?)', [username]);
                await db.run('INSERT INTO classusers (permissions) VALUES (?)', [permissions]);
                console.log("New user inserted successfully");

                req.session.user = username;
                req.session.permissions = permissions;
            } else {
                // Assign session data for existing user
                console.log("Updating session for existing user...");
                Object.assign(req.session, {
                    user: username,
                    permissions,
                    classID,
                    className
                });
            }

            // Redirect to the home page
            console.log("Redirecting to home page...");
            res.redirect('/');
        } catch (error) {
            console.error("Error during login process:", error.message);

            // Handle specific errors
            if (error.message.includes("Invalid or malformed token")) {
                return res.status(400).send("Invalid or malformed token. Please try logging in again.");
            }

            // Generic error response
            res.status(500).send("An error occurred during the login process. Please try again later.");
        }
    } else {
        // Redirect to the OAuth URL if no token is provided
        const redirectURL = 'http://localhost:3000/login';
        console.log("No token provided. Redirecting to OAuth URL:", redirectURL);
        res.redirect(`https://formbar.yorktechapps.com/oauth?redirectURL=${redirectURL}`);
    }
});


// Spotify authentication routes
app.get('/spotifyLogin', (req, res) => {
    const scopes = [
        'user-read-private',
        'user-read-email',
        'playlist-modify-public',
        'playlist-modify-private',
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-read-playback-state',
        'user-modify-playback-state',
        'user-read-currently-playing',
        'streaming',
        'app-remote-control'
    ];
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', async (req, res) => {
    const { error, code } = req.query;

    if (error) {
        console.error('Spotify Auth Error:', error);
        return res.send(`Error: ${error}`);
    }

    try {
        const data = await spotifyApi.authorizationCodeGrant(code);
        const { access_token, refresh_token, expires_in } = data.body;

        spotifyApi.setAccessToken(access_token);
        spotifyApi.setRefreshToken(refresh_token);

        // handles the token refresh in the background
        setInterval(async () => {
            try {
                const refreshData = await spotifyApi.refreshAccessToken();
                spotifyApi.setAccessToken(refreshData.body.access_token);
                console.log('Token refreshed successfully');
            } catch (err) {
                console.error('Error refreshing access token:', err);
            }
        }, (expires_in / 2) * 1000);

        res.redirect('/spotify');
    } catch (error) {
        console.error('Error during Spotify authorization:', error);
        res.status(500).send(`Error during authorization: ${error.message}`);
    }
});

// Spotify API routes
app.get('/search', async (req, res) => {
    const { q } = req.query;

    if (!q?.trim()) {
        return res.status(400).send('Bad Request: Missing or invalid query parameter');
    }

    if (!spotifyApi.getAccessToken()) {
        return res.status(401).send('Unauthorized: Access token missing or invalid');
    }

    try {
        // Search for tracks with the query
        const searchData = await spotifyApi.searchTracks(q, { limit: 50 });
        const tracks = searchData.body.tracks.items;

        if (tracks.length > 0) {
            // Map the tracks to include relevant details
            const results = tracks.slice(0, 5).map(track => ({
                name: track.name,
                artist: track.artists[0].name,
                uri: track.uri,
                album: {
                    name: track.album.name,
                    images: track.album.images,
                    smallestImage: track.album.images[track.album.images.length - 1]?.url,
                    largestImage: track.album.images[0]?.url
                }
            }));

            res.json(results);
        } else {
            res.json({
                error: 'not_found',
                message: 'No tracks were found for the given query'
            });
        }
    } catch (err) {
        console.error('Error searching tracks:', err);
        res.status(500).send(`Error: ${err.message}`);
    }
});

app.get('/currentSong', (req, res) => {
    spotifyApi.getMyCurrentPlayingTrack()
        .then(data => {
            if (data.body.item) {
                const track = data.body.item;
                const trackInfo = {
                    name: track.name,
                    artist: track.artists[0].name,
                    uri: track.uri,
                    cover: track.album.images[0].url,
                };
                res.json(trackInfo);
            } else {
                res.status(404).json({ error: 'No tracks found' });
            }
        })
        .catch(err => {
            console.error('Error getting current track:', err);
            res.status(500).send(`Error: ${err.message}`);
        });
});

app.post('/play', async (req, res) => {
    const { uri } = req.body;

    if (!uri) {
        return res.status(400).json({ error: "Missing track URI" });
    }

    if (!spotifyApi.getAccessToken()) {
        return res.status(401).json({ error: "Unauthorized: Access token missing or invalid" });
    }

    const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
    const match = uri.match(trackIdPattern);
    if (!match) {
        return res.status(400).json({ error: 'Invalid track URI format' });
    }

    try {
        // Get track details first to check if it's explicit
        const trackData = await spotifyApi.getTrack(match[1]);

        // Check if the track is explicit
        if (trackData.body.explicit) {
            return res.status(403).json({
                error: "explicit",
                message: "Cannot play explicit content"
            });
        }

        const devicesData = await spotifyApi.getMyDevices();
        const devices = devicesData.body.devices;

        if (devices.length === 0) {
            return res.status(400).json({ error: "No available devices found" });
        }

        await spotifyApi.play({
            uris: [uri],
            device_id: devices[0].id
        });

        await removeSongFromQueue(uri);

        res.json({
            success: true,
            message: "Playing track!",
            trackInfo: {
                name: trackData.body.name,
                artist: trackData.body.artists[0].name,
                uri: trackData.body.uri,
            }
        });
    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: "Playback failed, make sure Spotify is open" });
    }
});

app.post('/addToQueue', async (req, res) => {
    const { uri } = req.body;

    if (!uri) {
        return res.status(400).json({ error: "Missing track URI" });
    }

    if (!spotifyApi.getAccessToken()) {
        return res.status(401).json({ error: "Unauthorized: Access token missing or invalid" });
    }

    try {
        const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
        const match = uri.match(trackIdPattern);
        if (!match) {
            return res.status(400).json({ error: 'Invalid track URI format' });
        }

        const trackData = await spotifyApi.getTrack(match[1]);

        await spotifyApi.addToQueue(uri);

        res.json({
            success: true,
            message: "Track added to queue!",
            name: trackData.body.name,
            artist: trackData.body.artists[0].name
        });
    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: "Failed to add track to queue" });
    }
});

app.get('/queue', async (req, res) => {
    if (!spotifyApi.getAccessToken()) {
        return res.status(401).json({ error: "Unauthorized: Access token missing or invalid" });
    }

    try {
        const queuedSongs = await getQueuedSongs(100);

        // If the queue is empty, return an empty array
        if (!queuedSongs || queuedSongs.length === 0) {
            return res.json([]); // Return an empty array to indicate no songs in the queue
        }

        const trackInfoPromises = queuedSongs.map(async (song) => {
            const trackId = song.uri.split(':')[2]; // Extract ID from spotify:track:ID
            const trackData = await spotifyApi.getTrack(trackId);
            return {
                name: trackData.body.name,
                artist: trackData.body.artists[0].name,
                uri: trackData.body.uri,
                albumImage: trackData.body.album.images[trackData.body.album.images.length - 1]?.url
            };
        });

        const queueItems = await Promise.all(trackInfoPromises);
        res.json(queueItems);
    } catch (err) {
        console.error('Error fetching queue:', err);
        res.status(500).json({ error: "Failed to fetch queue" });
    }
});

app.post('/youtube', async (req, res) => {
    const url = req.body.url;
    if (ytdl.validateURL(url)) {
        const info = await ytdl.getInfo(url);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
        res.header('Content-Disposition', `attachment; filename="${info.videoDetails.title}.mp4"`);
        ytdl(url, { format: format }).pipe(res);
    } else {
        res.status(400).send('Invalid URL');
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'youtube.ejs'));
});

app.post('/preview', async (req, res) => {
    const { PreviewUri } = req.body;
    
    if (!PreviewUri) {
        return res.status(400).json({ error: "Missing track URI" });
    }

    try {
        const trackId = PreviewUri.split(':')[2]; // Extract ID from spotify:track:ID
        
        // Send back just the track ID for the iframe
        res.json({
            success: true,
            previewUrl: trackId
        });
    } catch (err) {
        console.error('Preview Error:', err);
        res.status(500).json({ error: "Failed to process preview request" });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running on port http://localhost:${port}`);
});
