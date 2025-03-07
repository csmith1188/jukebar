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
    saveUninitialized: false
}));

// Main routes
app.use('/', routes);

// Authentication routes
app.get('/login', async (req, res) => {
    if (req.query.token) {
        try {
            const tokenData = jwt.decode(req.query.token);
            const { username, permissions, classID, className, classPermissions } = tokenData;

            const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
            
            if (!user) {
                await db.run('INSERT INTO users (username) VALUES (?)', [username]);
                await db.run('INSERT INTO classusers (permissions) VALUES (?)', [permissions]);
                
                req.session.user = username;
                req.session.permissions = permissions;
                console.log("User inserted into database successfully!");
            } else {
                Object.assign(req.session, {
                    user: username,
                    permissions,
                    classID,
                    className
                });
            }
            
            res.redirect('/');
        } catch (error) {
            console.error("Database operation failed:", error);
            res.status(500).send("Internal Server Error");
        }
    } else {
        res.redirect('https://formbar.yorktechapps.com/oauth?redirectURL=http://localhost:3000/login');
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

        // Handle token refresh in the background
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
        // First try searching specifically for clean/radio versions
        let searchData = await spotifyApi.searchTracks(`${q} radio edit clean`, { limit: 50 });
        let tracks = searchData.body.tracks.items.filter(track => !track.explicit);

        // If no clean versions found, try the original search but still filter out explicit tracks
        if (tracks.length === 0) {
            searchData = await spotifyApi.searchTracks(q, { limit: 50 });
            tracks = searchData.body.tracks.items.filter(track => !track.explicit);
        }

        if (tracks.length > 0) {
            // Find a track that specifically mentions clean/radio edit
            let track = tracks.find(track => {
                const trackName = track.name.toLowerCase();
                return trackName.includes('radio edit') ||
                       trackName.includes('clean') ||
                       trackName.includes('radio version') ||
                       trackName.includes('clean version');
            });

            // If no specific clean version found, use the first non-explicit track
            if (!track) {
                track = tracks[0];
            }

            res.json({
                name: track.name,
                artist: track.artists[0].name,
                uri: track.uri,
                album: {
                    name: track.album.name,
                    images: track.album.images,
                    smallestImage: track.album.images[track.album.images.length - 1].url,
                    largestImage: track.album.images[0].url
                }
            });
        } else {
            res.json({
                error: 'explicit',
                message: 'Only explicit versions of this song were found'
            });
        }
    } catch (err) {
        console.error('Error searching tracks:', err);
        res.status(500).send(`Error: ${err.message}`);
    }
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

// Start server
app.listen(port, () => {
    console.log(`Server running on port http://localhost:${port}`);
});