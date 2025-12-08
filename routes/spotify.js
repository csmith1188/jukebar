const express = require('express');
const router = express.Router();
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const db = require('../utils/database');
const { logTransaction } = require('./logging');
const queueManager = require('../utils/queueManager');
const { isAuthenticated } = require('../middleware/auth');

// Middleware to check if user has teacher permissions (owner or permission >= 4)
const requireTeacherAccess = (req, res, next) => {
    if (req.session?.permission >= 4 || req.session?.token?.id === Number(process.env.OWNER_ID)) {
        return next();
    }
    return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
};

// Helpers for banned songs
function getBannedSongs() {
    return new Promise((resolve, reject) => {
        db.all('SELECT track_name, artist_name FROM banned_songs', (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function isTrackBannedByNameArtist(name, artist) {
    try {
        const banned = await getBannedSongs();
        const n = (name || '').trim().toLowerCase();
        const a = (artist || '').trim().toLowerCase();
        return banned.some(b => {
            const bannedName = (b.track_name || '').trim().toLowerCase();
            const bannedArtist = (b.artist_name || '').trim().toLowerCase();
            return n.startsWith(bannedName) && bannedArtist === a;
        });
    } catch (e) {
        console.error('Error checking banned songs:', e);
        return false;
    }
}
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
        let { query, source } = req.body || {};
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

        // if the song is banned hide it
        const isTeacherPanel = source === 'teacher';
        const isTeacher = (req.session?.permission >= 4 || req.session?.token?.id === Number(process.env.OWNER_ID));
        try {
            const banned = await getBannedSongs();
            // Use function to check if track name starts with banned name and artist matches
            if (isTeacher && isTeacherPanel) {
                simplified = simplified.map(t => ({
                    ...t,
                    isBanned: banned.some(b => {
                        const bannedName = (b.track_name || '').trim().toLowerCase();
                        const bannedArtist = (b.artist_name || '').trim().toLowerCase();
                        return t.name.trim().toLowerCase().startsWith(bannedName) && t.artist.trim().toLowerCase() === bannedArtist;
                    })
                }));
            } else {
                simplified = simplified.filter(t => !banned.some(b => {
                    const bannedName = (b.track_name || '').trim().toLowerCase();
                    const bannedArtist = (b.artist_name || '').trim().toLowerCase();
                    return t.name.trim().toLowerCase().startsWith(bannedName) && t.artist.trim().toLowerCase() === bannedArtist;
                }));
            }
        } catch (e) {
            console.warn('Could not load banned songs; proceeding without filter');
            if (isTeacher && isTeacherPanel) {
                simplified = simplified.map(t => ({ ...t, isBanned: false }));
            }
        }
        return res.json({
            ok: true,
            tracks: { items: simplified }
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'search');
    }
});

router.post('/unbanTrack', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { name, artist } = req.body || {};
        if (!name || !artist) return res.status(400).json({ ok: false, error: 'Missing track name or artist' });

        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM banned_songs WHERE lower(trim(track_name)) = lower(trim(?)) AND lower(trim(artist_name)) = lower(trim(?))',
                [name, artist],
                function (err) {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        return res.json({ ok: true, message: 'Track unbanned successfully' });
    } catch (error) {
        console.error('Unban track error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to unban track' });
    }
});

// Teacher-only: Ban a track by name/artist (optionally record URI)
router.post('/banTrack', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { name, artist } = req.body || {};
        if (!name || !artist) return res.status(400).json({ ok: false, error: 'Missing track name or artist' });

        // Avoid duplicates
        const alreadyBanned = await isTrackBannedByNameArtist(name, artist);
        if (alreadyBanned) {
            return res.json({ ok: true, message: 'Track already banned' });
        }

        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO banned_songs (track_name, artist_name) VALUES (?, ?)',
                [name, artist],
                function (err) {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        return res.json({ ok: true, message: 'Track banned successfully' });
    } catch (error) {
        console.error('Ban track error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to ban track' });
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

            // 📖 Fetch metadata for all tracks from database
            const trackUris = items.map(item => item.uri);
            const metadataMap = await new Promise((resolve) => {
                if (trackUris.length === 0) {
                    resolve({});
                    return;
                }
                
                const placeholders = trackUris.map(() => '?').join(',');
                const query = `SELECT track_uri, added_by FROM queue_metadata WHERE track_uri IN (${placeholders})`;
                
                db.all(query, trackUris, (err, rows) => {
                    if (err) {
                        console.error('Failed to fetch queue metadata:', err);
                        resolve({});
                    } else {
                        const map = {};
                        if (rows) {
                            rows.forEach(row => {
                                map[row.track_uri] = row.added_by;
                            });
                        }
                        resolve(map);
                    }
                });
            });

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
                duration_ms: t.duration_ms,
                addedBy: metadataMap[t.uri] || 'Spotify'  // ✨ Add the addedBy field
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
//console.log('addToQueue - Session:', req.session?.token?.id, 'hasPaid:', req.session?.hasPaid);
    if (!req.session || !req.session.token || !req.session.token.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const ownerId = Number(process.env.OWNER_ID);
    if (req.session.token.id === ownerId) {
        try {
            await ensureSpotifyAccessToken();

            const { uri, anonMode } = req.body;
            if (!uri) return res.status(400).json({ error: "Missing track URI" });

            const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
            const match = uri.match(trackIdPattern);
            if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

            const trackId = match[1];

            const trackData = await spotifyApi.getTrack(trackId);
            const track = trackData.body;
            const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
            const isAnon = anonMode ? 1 : 0;
            
            const trackInfo = {
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                cover: track.album.images[0].url,
                addedBy: username
            };

            await spotifyApi.addToQueue(uri);

            const queueTrack = {
                uri: track.uri,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                addedBy: username,
                addedAt: Date.now(),
                image: track.album.images[0]?.url,
                isAnon: isAnon
            };
//console.log('Adding track to queue with addedBy:', username, 'type:', typeof username); // Debug log
            queueManager.addToQueue(queueTrack);

            // 📝 Save metadata to database (synchronously)
//console.log('Saving to DB - URI:', track.uri, 'addedBy:', username);
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT OR REPLACE INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon) 
                     VALUES (?, ?, ?, ?, ?)`,
                    [track.uri, username, Date.now(), username, isAnon],
                    function(err) {
                        if (err) {
                            console.error('Failed to save queue metadata:', err);
                            reject(err);
                        } else {
//console.log('Saved queue metadata for:', track.name, 'URI:', track.uri, 'LastID:', this.lastID, 'Changes:', this.changes);
                            // Verify it was actually saved
                            db.get('SELECT * FROM queue_metadata WHERE track_uri = ?', [track.uri], (verifyErr, row) => {
                                if (verifyErr) {
                                    console.error('Verification failed:', verifyErr);
                                } else {
//console.log('Verification: Row exists with addedBy:', row?.added_by);
                                }
                            });
                            resolve();
                        }
                    }
                );
            });

            db.run(
                "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session.token?.id],
                (err) => {
                    if (err) console.error('Error updating songs played:', err);
                }
            );

//console.log(`Add to queue successful for owner (ID: ${req.session.token.id})`);
            res.json({ success: true, message: "Track queued!", trackInfo });
            return;
        } catch (err) {
            console.error('Error in /addToQueue (admin):', err);
            return res.status(500).json({ error: err.message });
        }
    }

    // For non-admin users, check payment
    if (!req.session.hasPaid) {
//console.log('addToQueue - Payment required. User ID:', req.session.token.id, 'hasPaid:', req.session.hasPaid);
        return res.status(403).json({ ok: false, error: 'Payment required to add to queue' });
    }

    try {
        await ensureSpotifyAccessToken();

        const { uri, anonMode } = req.body;
        if (!uri) return res.status(400).json({ error: "Missing track URI" });

        const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
        const match = uri.match(trackIdPattern);
        if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

        const trackId = match[1];

        const trackData = await spotifyApi.getTrack(trackId);
        const track = trackData.body;
        const isAnon = anonMode ? 1 : 0;
        const trackInfo = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            uri: track.uri,
            cover: track.album.images[0].url,
        };

        // Check banned songs
        if (await isTrackBannedByNameArtist(trackInfo.name, trackInfo.artist)) {
            return res.status(403).json({ ok: false, error: 'This track has been banned by the teacher' });
        }

        // Check banned songs
        if (await isTrackBannedByNameArtist(trackInfo.name, trackInfo.artist)) {
            return res.status(403).json({ ok: false, error: 'This track has been banned by the teacher' });
        }

        await spotifyApi.addToQueue(uri);

        // Also add to queueManager for WebSocket updates
        const username2 = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        
        const queueTrack = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            addedBy: username2,
            addedAt: Date.now(),
            image: track.album.images[0]?.url,
            isAnon: isAnon
        };
        queueManager.addToQueue(queueTrack);

        // 📝 Save metadata to database (synchronously)
//console.log('Saving to DB - URI:', track.uri, 'addedBy:', username2, 'type:', typeof username2);
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT OR REPLACE INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon) 
                 VALUES (?, ?, ?, ?, ?)`,
                [track.uri, username2, Date.now(), username2, isAnon],
                function(err) {
                    if (err) {
                        console.error('Failed to save queue metadata:', err);
                        reject(err);
                    } else {
//console.log('Saved queue metadata for:', track.name, 'URI:', track.uri, 'LastID:', this.lastID, 'Changes:', this.changes);
                        // Verify it was actually saved
                        db.get('SELECT * FROM queue_metadata WHERE track_uri = ?', [track.uri], (verifyErr, row) => {
                            if (verifyErr) {
                                console.error('Verification failed:', verifyErr);
                            } else {
//console.log('Verification: Row exists with addedBy:', row?.added_by);
                            }
                        });
                        resolve();
                    }
                }
            );
        });

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
//console.log('skip - Session:', req.session?.token?.id, 'hasPaid:', req.session?.hasPaid);
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
//console.log(`Skip successful for owner (ID: ${req.session.token.id})`);
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
//console.log('skip - Payment required. User ID:', req.session.token.id, 'hasPaid:', req.session.hasPaid);
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

        const username3 = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        
        const track = {
            uri,
            name: trackName,
            artist,
            addedBy: username3,
            addedAt: Date.now()
        };

        queueManager.addToQueue(track);

        // Log the transaction
        if (req.session.token?.id) {
            await logTransaction(req.session.token.id, username3, 'QUEUE', uri, trackName, artist, 50);
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

router.post('/purchaseShield', isAuthenticated, async (req, res) => {
    console.log('=== PURCHASE SHIELD REQUEST ===');
    const { trackUri } = req.body;
    const userId = req.session.token?.id;
    const displayName = req.session.user;
    
    console.log('Request body:', req.body);
    console.log('User ID:', userId);
    console.log('Display name:', displayName);
    console.log('Track URI:', trackUri);

    // Validation: Check authentication
    if (!userId || !displayName) {
        console.error('❌ User not properly authenticated');
        return res.status(401).json({ ok: false, error: 'User not authenticated' });
    }

    // Validation: Check track URI
    if (!trackUri) {
        console.error('❌ Track URI missing from request');
        return res.status(400).json({ ok: false, error: 'Track URI is required' });
    }

    // Owner bypass - they can add shields for free
    const ownerId = Number(process.env.OWNER_ID);
    const isOwner = userId === ownerId;
    console.log('Is owner:', isOwner, '(userId:', userId, 'ownerId:', ownerId, ')');

    try {
        // Step 1: Verify track exists in queue
        console.log('Step 1: Checking if track exists in queue...');
        const track = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM queue_metadata WHERE track_uri = ?", [trackUri], (err, row) => {
                if (err) {
                    console.error('❌ Database error querying queue_metadata:', err);
                    reject(err);
                } else {
                    console.log('Track found in queue:', row);
                    resolve(row);
                }
            });
        });

        if (!track) {
            console.error('❌ Track not found in queue:', trackUri);
            return res.status(404).json({ ok: false, error: 'Track not found in queue' });
        }

        console.log('✅ Track found:', track.track_name, 'by', track.artist_name);

        // Step 2: Verify payment for non-owner
        if (!isOwner) {
            console.log('Step 2: Checking payment status...');
            console.log('hasPaid:', req.session.hasPaid);
            
            if (!req.session.hasPaid) {
                console.error('❌ Payment required but not received');
                return res.status(402).json({ ok: false, error: 'Payment required' });
            }
            console.log('✅ Payment verified');
        } else {
            console.log('Step 2: Skipped (owner bypass)');
        }

        // Step 3: Update shield count
        console.log('Step 3: Incrementing shield count...');
        const updateResult = await new Promise((resolve, reject) => {
            db.run(
                "UPDATE queue_metadata SET skip_shields = COALESCE(skip_shields, 0) + 1 WHERE track_uri = ?",
                [trackUri],
                function(err) {
                    if (err) {
                        console.error('❌ Database error updating shields:', err);
                        reject(err);
                    } else {
                        console.log('✅ Shield count incremented. Rows affected:', this.changes);
                        resolve(this.changes);
                    }
                }
            );
        });

        if (updateResult === 0) {
            console.error('❌ No rows updated - track may have been removed from queue');
            return res.status(404).json({ ok: false, error: 'Track no longer in queue' });
        }

        // Step 4: Log transaction
        console.log('Step 4: Logging transaction...');
        try {
            await logTransaction({
                userID: userId,
                displayName: displayName,
                action: 'shield',
                trackURI: trackUri,
                trackName: track.track_name,
                artistName: track.artist_name,
                cost: isOwner ? 0 : 25
            });
            console.log('✅ Transaction logged');
        } catch (logErr) {
            console.error('⚠️ Failed to log transaction (non-fatal):', logErr);
            // Continue anyway - shield was added
        }

        // Step 5: Clear payment flag for non-owner
        if (!isOwner) {
            console.log('Step 5: Clearing payment flag...');
            req.session.hasPaid = false;
            console.log('✅ Payment flag cleared');
        }

        // Step 6: Broadcast queue update
        console.log('Step 6: Broadcasting queue update...');
        try {
            // Force re-sync from Spotify to get updated metadata
            await queueManager.syncWithSpotify(spotifyApi);
            console.log('✅ Queue synced and broadcasted');
        } catch (broadcastErr) {
            console.error('⚠️ Failed to sync queue (non-fatal):', broadcastErr);
            // Continue anyway - shield was added
        }

        // Step 7: Save session and respond
        console.log('Step 7: Saving session and responding...');
        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('⚠️ Session save error (non-fatal):', saveErr);
            }
            console.log('✅ Shield purchase complete!');
            console.log('================================');
            res.json({ ok: true, message: 'Shield added successfully' });
        });

    } catch (error) {
        console.error('❌ FATAL ERROR in purchaseShield:', error);
        console.error('Error stack:', error.stack);
        console.log('================================');
        res.status(500).json({ ok: false, error: 'Server error', details: error.message });
    }
});


module.exports = router;
