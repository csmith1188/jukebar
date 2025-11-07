const express = require('express');
const router = express.Router();
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const db = require('../utils/database');
const { logTransaction } = require('./logging');
const queueManager = require('../utils/queueManager');

// Store currently playing track info (legacy - use queueManager instead)
let currentTrack = null;

// Helper function to handle Spotify API errors consistently
function handleSpotifyError(error, res, action = 'operation') {
    console.error(`Spotify ${action} error:`, error);
    
    // Handle network connectivity errors
    if (error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return res.status(503).json({ 
            ok: false, 
            error: 'Unable to connect to Spotify. Please check your internet connection and try again.' 
        });
    }
    
    // Handle authentication errors
    if (error.statusCode === 401) {
        return res.status(401).json({ ok: false, error: 'Spotify authentication failed' });
    }
    
    // Handle rate limiting
    if (error.statusCode === 429) {
        return res.status(429).json({ 
            ok: false, 
            error: 'Too many requests to Spotify. Please wait a moment and try again.' 
        });
    }
    
    // Handle 404 errors (no active device)
    if (error.statusCode === 404) {
        return res.status(400).json({ 
            ok: false, 
            error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' 
        });
    }
    
    // Generic error
    return res.status(500).json({ ok: false, error: `Failed to ${action}` });
}


router.post('/search', async (req, res) => {
    try {
        let { query } = req.body || {};
        if (!query || !query.trim()) {
            return res.status(400).json({ ok: false, error: 'Missing query' });
        }

        await ensureSpotifyAccessToken();

        const searchData = await spotifyApi.searchTracks(query, { limit: 25 });
        const items = searchData.body.tracks.items || [];

        let simplified = items.map(t => ({
            id: t.id,
            name: t.name,
            artist: t.artists.map(a => a.name).join(', '),
            uri: t.uri,
            album: {
                name: t.album.name,
                image: t.album.images?.[0]?.url || null
            },
            explicit: t.explicit,
            duration_ms: t.duration_ms
        }));
        // filter explicit songs and songs longer than 7 minutes
        simplified = simplified.filter(t => t.explicit === false && t.duration_ms < 420000);
        return res.json({
            ok: true,
            tracks: { items: simplified }
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'search');
    }
});

router.get('/getQueue', async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await fetch('https://api.spotify.com/v1/me/player/queue', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        });
        if (response.status === 200) {
            const queueData = await response.json();
            const items = queueData.queue || [];

            let simplified = items.map(t => ({
                id: t.id,
                name: t.name,
                artist: t.artists.map(a => a.name).join(', '),
                uri: t.uri,
                album: {
                    name: t.album.name,
                    image: t.album.images?.[0]?.url || null
                },
                explicit: t.explicit,
                duration_ms: t.duration_ms
            }));
            res.json({
                ok: true,
                tracks: { items: simplified }
            });
        } else {
            res.status(response.status).json({ ok: false, error: 'Failed to get queue' });
        }
    } catch (error) {
        console.error('Get queue error:', error);
        res.status(500).json({ ok: false, error: 'Failed to get queue', details: error.message });
    }
});

router.post('/addToQueue', async (req, res) => {
    console.log('addToQueue - Session:', req.session?.token?.id, 'hasPaid:', req.session?.hasPaid);
    if (!req.session || !req.session.token || !req.session.token.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // Admin/Owner bypass
    const ownerId = Number(process.env.OWNER_ID);
    if (req.session.token.id === ownerId) {
        try {
            await ensureSpotifyAccessToken();

            const { uri } = req.body;
            if (!uri) return res.status(400).json({ error: "Missing track URI" });

            const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
            const match = uri.match(trackIdPattern);
            if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

            const trackId = match[1];

            const trackData = await spotifyApi.getTrack(trackId);
            const track = trackData.body;
            const trackInfo = {
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                cover: track.album.images[0].url,
            };

            await spotifyApi.addToQueue(uri);

            // Also add to queueManager for WebSocket updates
            const queueTrack = {
                uri: track.uri,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                addedBy: req.session.user,
                addedAt: Date.now(),
                image: track.album.images[0]?.url
            };
            queueManager.addToQueue(queueTrack);

            db.run(
                "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session.token?.id],
                (err) => {
                    if (err) console.error('Error updating songs played:', err);
                }
            );

            console.log(`Add to queue successful for owner (ID: ${req.session.token.id})`);
            res.json({ success: true, message: "Track queued!", trackInfo });
            return;
        } catch (err) {
            console.error('Error in /addToQueue (admin):', err);
            return res.status(500).json({ error: err.message });
        }
    }

    // For non-admin users, check payment
    if (!req.session.hasPaid) {
        console.log('addToQueue - Payment required. User ID:', req.session.token.id, 'hasPaid:', req.session.hasPaid);
        return res.status(403).json({ ok: false, error: 'Payment required to add to queue' });
    }

    try {
        await ensureSpotifyAccessToken();

        const { uri } = req.body;
        if (!uri) return res.status(400).json({ error: "Missing track URI" });

        const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
        const match = uri.match(trackIdPattern);
        if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

        const trackId = match[1];

        const trackData = await spotifyApi.getTrack(trackId);
        const track = trackData.body;
        const trackInfo = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            uri: track.uri,
            cover: track.album.images[0].url,
        };

        await spotifyApi.addToQueue(uri);

        // Also add to queueManager for WebSocket updates
        const queueTrack = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            addedBy: req.session.user,
            addedAt: Date.now(),
            image: track.album.images[0]?.url
        };
        queueManager.addToQueue(queueTrack);

        db.run(
            "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session.token?.id],
            (err) => {
                if (err) console.error('Error updating songs played:', err);
            }
        );

        //log the transaction
        if (currentTrack) {
            await logTransaction({
                userID: req.session.token.id,
                displayName: req.session.token.displayName || req.session.user,
                action: 'play',
                trackURI: trackInfo.uri,
                trackName: trackInfo.name,
                artistName: trackInfo.artist,
                cost: 50
            });

        }

        // Clear payment flag after successful queue addition
        req.session.hasPaid = false;
        req.session.save(() => {
            res.json({ success: true, message: "Track queued!", trackInfo });
        });

    } catch (err) {
        console.error('Error in /addToQueue:', err);
        res.status(500).json({ error: err.message });
    }
});


router.get('/currentlyPlaying', async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        });
        if (response.status === 200) {
            const data = await response.json();

            // Check if something is playing
            if (!data || !data.item) {
                currentTrack = null;
                return res.json({ ok: true, tracks: { items: [] } });
            }
            const track = data.item;
            const simplified = ({
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                album: {
                    name: track.album.name,
                    image: track.album.images?.[0]?.url || null
                },
                explicit: track.explicit,
                duration_ms: track.duration_ms
            });

            // Store current track for other endpoints
            currentTrack = simplified;

            res.json({
                ok: true,
                tracks: { items: [simplified] }
            });
        } else if (response.status === 204) {
            currentTrack = null;
            res.json({ ok: true, tracks: { items: [] } });
        } else {
            res.status(response.status).json({ ok: false, error: 'Failed to get queue' });
        }
    } catch (error) {
        console.error('Get queue error:', error);
        res.status(500).json({ ok: false, error: 'Failed to get queue', details: error.message });
    }
});

router.post('/skip', async (req, res) => {
    console.log('skip - Session:', req.session?.token?.id, 'hasPaid:', req.session?.hasPaid);
    if (!req.session || !req.session.token || !req.session.token.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }


    const ownerId = Number(process.env.OWNER_ID);
    if (req.session.token.id === ownerId) {
        try {
            await ensureSpotifyAccessToken();
            await spotifyApi.skipToNext();
            
            // Update queueManager and broadcast to clients
            const nextTrack = queueManager.skipTrack();
            console.log(`Skip successful for owner (ID: ${req.session.token.id})`);
            res.json({ ok: true, currentTrack: nextTrack });
            return;
        } catch (error) {
            console.error('Skip error:', error);
            // Handle 404 errors when no active playback device
            if (error.statusCode === 404) {
                return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
            }
            return res.status(500).json({ ok: false, error: 'Failed to skip', details: error.message });
        }
    }

    // For non-admin users, check payment and claim it
    if (!req.session.hasPaid) {
        console.log('skip - Payment required. User ID:', req.session.token.id, 'hasPaid:', req.session.hasPaid);
        return res.status(403).json({ ok: false, error: 'Payment required to skip' });
    }

    try {
        await ensureSpotifyAccessToken();
        await spotifyApi.skipToNext();
        
        // Update queueManager and broadcast to clients
        const nextTrack = queueManager.skipTrack();
        
        if (currentTrack) {
            await logTransaction({
                userID: req.session.token.id,
                displayName: req.session.user,
                action: 'skip',
                trackURI: currentTrack.uri,
                trackName: currentTrack.name,
                artistName: currentTrack.artist,
                cost: 125
            });
        }
        // Clear payment flag after successful skip
        req.session.hasPaid = false;
        req.session.save(() => {
            res.json({ ok: true, message: 'Track skipped and logged', currentTrack: nextTrack });
        });


    } catch (error) {
        console.error('Skip error:', error);
        // Handle 404 errors when no active playback device
        if (error.statusCode === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
        }
        res.status(500).json({ ok: false, error: 'Failed to skip', details: error.message });
    }
});

// Get current queue state
router.get('/queue/state', (req, res) => {
    try {
        const state = queueManager.getCurrentState();
        res.json({ ok: true, ...state });
    } catch (error) {
        console.error('Queue state error:', error);
        res.status(500).json({ ok: false, error: 'Failed to get queue state' });
    }
});

// Add track to queue (instead of playing immediately)
router.post('/queue/add', async (req, res) => {
    try {
        const { uri, trackName, artist } = req.body;
        
        if (!uri) {
            return res.status(400).json({ ok: false, error: 'Missing track URI' });
        }

        const track = {
            uri,
            name: trackName,
            artist,
            addedBy: req.session.user,
            addedAt: Date.now()
        };

        queueManager.addToQueue(track);
        
        // Log the transaction
        if (req.session.token?.id) {
            await logTransaction(req.session.token.id, req.session.user, 'QUEUE', uri, trackName, artist, 50);
        }

        res.json({ ok: true, message: 'Track added to queue', queue: queueManager.queue });
    } catch (error) {
        console.error('Queue add error:', error);
        res.status(500).json({ ok: false, error: 'Failed to add to queue' });
    }
});

// Skip current track (for teachers/admins)
router.post('/queue/skip', async (req, res) => {
    try {
        // Check permissions
        if (req.session.permission < 4 && req.session.token?.id !== Number(process.env.OWNER_ID)) {
            return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
        }

        const nextTrack = queueManager.skipTrack();
        
        if (nextTrack) {
            // Actually skip on Spotify
            await ensureSpotifyAccessToken();
            await spotifyApi.skipToNext();
            
            res.json({ ok: true, message: 'Track skipped', currentTrack: nextTrack });
        } else {
            res.json({ ok: true, message: 'No tracks in queue to skip to' });
        }
    } catch (error) {
        console.error('Queue skip error:', error);
        // Handle 404 errors when no active playback device
        if (error.statusCode === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
        }
        res.status(500).json({ ok: false, error: 'Failed to skip track' });
    }
});

module.exports = router;
