const express = require('express');
const router = express.Router();
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const db = require('../utils/database');
const { logTransaction } = require('./logging');
const queueManager = require('../utils/queueManager');
const { isAuthenticated } = require('../middleware/auth');
const { isOwner, getFirstOwnerId } = require('../utils/owners');
const { logSkipActivity } = require('../utils/skipActivity');
const { refund: poolRefund } = require('../utils/transferManager');
const { getCurrentClassId } = require('./socket');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Play random sound from /sfx folder
let isPlayingSound = false;

const APRIL_FOOLS_URI = 'spotify:track:0rQvvjAkX1B0gcJwjEGQZW';
const APRIL_FOOLS_CHANCE = 0.3; // 30% chance

function isAprilFools() {
    const now = new Date();
    return now.getMonth() === 3 && now.getDate() === 1; // month is 0-indexed
}

function shouldAprilFool() {
    return isAprilFools() && Math.random() < APRIL_FOOLS_CHANCE;
}

function playRandomBlockedSound() {
    if (isPlayingSound) {
        console.log('Already playing a sound; skipping');
        return null;
    }

    try {
        const sfxDir = path.join(__dirname, '..', 'public', 'sfx');
        const files = fs.readdirSync(sfxDir).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));

        if (files.length === 0) {
            console.warn('No sound files found in /sfx');
            return null;
        }

        const randomFile = files[Math.floor(Math.random() * files.length)];
        const soundPath = path.join(sfxDir, randomFile);

        console.log(`Playing blocked sound: ${randomFile}`);
        isPlayingSound = true;

        exec(`omxplayer "${soundPath}"`, (err) => {
            isPlayingSound = false;
            if (err) console.error('Error playing sound:', err);
        });

        return randomFile; // Return filename for logging
    } catch (err) {
        isPlayingSound = false;
        console.error('Error in playRandomBlockedSound:', err);
        return null;
    }
}

// Middleware to check if user has teacher permissions (owner or permission >= 4)
const requireTeacherAccess = (req, res, next) => {
    if (req.session?.permission >= 4 || isOwner(req.session?.token?.id)) {
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

function getAllowedPlaylist(playlistId, classId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT spotify_playlist_id, name, owner_name, image_url, total_tracks, is_allowed
             FROM allowed_playlists
             WHERE spotify_playlist_id = ? AND class_id = ?`,
            [playlistId, classId],
            (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            }
        );
    });
}

function getAllowedPlaylists(classId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT spotify_playlist_id, name, owner_name, image_url, total_tracks
             FROM allowed_playlists
             WHERE is_allowed = 1 AND class_id = ?
             ORDER BY lower(name) ASC`,
            [classId],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            }
        );
    });
}

function getAllowedPlaylistMap(classId) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT spotify_playlist_id, is_allowed FROM allowed_playlists WHERE class_id = ?`, [classId], (err, rows) => {
            if (err) return reject(err);
            const allowedMap = new Map();
            (rows || []).forEach((row) => {
                allowedMap.set(row.spotify_playlist_id, !!row.is_allowed);
            });
            resolve(allowedMap);
        });
    });
}

function upsertPlaylistMetadata(playlist, updatedBy = null, classId = null) {
    return new Promise((resolve, reject) => {
        // Check if this playlist+class combo already exists
        db.get(
            `SELECT id FROM allowed_playlists WHERE spotify_playlist_id = ? AND class_id = ?`,
            [playlist.id, classId],
            (err, row) => {
                if (err) return reject(err);
                if (row) {
                    // Update existing
                    db.run(
                        `UPDATE allowed_playlists
                         SET name = ?, owner_name = ?, image_url = ?, total_tracks = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE spotify_playlist_id = ? AND class_id = ?`,
                        [
                            playlist.name || 'Untitled Playlist',
                            playlist.owner || 'Unknown',
                            playlist.image || null,
                            Number(playlist.totalTracks) || 0,
                            updatedBy || null,
                            playlist.id,
                            classId
                        ],
                        (err) => {
                            if (err) return reject(err);
                            resolve();
                        }
                    );
                } else {
                    // Insert new
                    db.run(
                        `INSERT INTO allowed_playlists
                         (spotify_playlist_id, name, owner_name, image_url, total_tracks, updated_by, updated_at, class_id)
                         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
                        [
                            playlist.id,
                            playlist.name || 'Untitled Playlist',
                            playlist.owner || 'Unknown',
                            playlist.image || null,
                            Number(playlist.totalTracks) || 0,
                            updatedBy || null,
                            classId
                        ],
                        (err) => {
                            if (err) return reject(err);
                            resolve();
                        }
                    );
                }
            }
        );
    });
}

function setPlaylistAllowedState(playlistId, isAllowed, teacherId, classId) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE allowed_playlists
             SET is_allowed = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
             WHERE spotify_playlist_id = ? AND class_id = ?`,
            [isAllowed ? 1 : 0, teacherId || null, playlistId, classId],
            function (err) {
                if (err) return reject(err);
                resolve(this.changes || 0);
            }
        );
    });
}

async function fetchPlaylistTracks(playlistId) {
    await ensureSpotifyAccessToken();
    const tracks = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const response = await spotifyApi.getPlaylistTracks(playlistId, { limit, offset });
        const items = response.body?.items || [];
        tracks.push(...items);
        if (items.length < limit) break;
        offset += limit;
    }

    return tracks;
}

function computePlaylistCost(trackCount) {
    const songAmount = Number(process.env.SONG_AMOUNT) || 50;
    return Math.min(Math.round(songAmount * Math.sqrt(trackCount)), 500);
}

async function getQueueUriSet() {
    const queueUris = new Set((queueManager.queue || []).map((track) => track?.uri).filter(Boolean));
    const currentUri = queueManager.currentTrack?.uri;
    if (currentUri) queueUris.add(currentUri);
    return queueUris;
}

async function getQueueablePlaylistTracks(playlistId) {
    const [rawItems, bannedSongs, queueUris] = await Promise.all([
        fetchPlaylistTracks(playlistId),
        getBannedSongs(),
        getQueueUriSet()
    ]);

    const bannedPairs = new Set(
        (bannedSongs || []).map((row) => `${(row.track_name || '').trim().toLowerCase()}::${(row.artist_name || '').trim().toLowerCase()}`)
    );

    const queueableTracks = [];
    const skipped = { unplayable: 0, banned: 0, duplicate: 0 };

    for (const item of rawItems) {
        const track = item?.track;
        if (!track || track.is_local || !track.uri || !track.uri.startsWith('spotify:track:')) {
            skipped.unplayable += 1;
            continue;
        }

        const name = (track.name || '').trim();
        const artist = (track.artists || []).map((a) => a.name).join(', ').trim();
        const bannedKey = `${name.toLowerCase()}::${artist.toLowerCase()}`;
        if (bannedPairs.has(bannedKey)) {
            skipped.banned += 1;
            continue;
        }

        if (queueUris.has(track.uri)) {
            skipped.duplicate += 1;
            continue;
        }

        queueUris.add(track.uri);
        queueableTracks.push({
            uri: track.uri,
            name,
            artist,
            image: track.album?.images?.[0]?.url || null
        });
    }

    return { queueableTracks, skipped };
}

async function getPlaylistPlayableStats(playlistId) {
    const rawItems = await fetchPlaylistTracks(playlistId);
    let playableCount = 0;
    let unplayableCount = 0;

    for (const item of rawItems) {
        const track = item?.track;
        if (!track || track.is_local || !track.uri || !track.uri.startsWith('spotify:track:')) {
            unplayableCount += 1;
            continue;
        }
        playableCount += 1;
    }

    return {
        playableCount,
        skipped: {
            unplayable: unplayableCount,
            banned: 0,
            duplicate: 0
        }
    };
}

async function getCurrentTrackUri() {
    await ensureSpotifyAccessToken();
    const playback = await spotifyApi.getMyCurrentPlayingTrack();
    return playback?.body?.item?.uri || null;
}

async function isPlaylistCurrentlyPlaying(playlistId) {
    const currentTrackUri = await getCurrentTrackUri();
    if (!currentTrackUri) return false;

    const playlistItems = await fetchPlaylistTracks(playlistId);
    return playlistItems.some((item) => item?.track?.uri === currentTrackUri);
}


router.post('/search', async (req, res) => {
    try {
        let { query, source, offset } = req.body || {};
        if (!query || !query.trim()) {
            return res.status(400).json({ ok: false, error: 'Missing query' });
        }

        offset = Math.max(0, parseInt(offset) || 0);
        await ensureSpotifyAccessToken();

        const searchData = await spotifyApi.searchTracks(query, { limit: 50, offset });
        const items = searchData.body.tracks.items || [];
        const total = searchData.body.tracks.total || 0;

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
        const isTeacher = (req.session?.permission >= 4 || isOwner(req.session?.token?.id));
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
        const nextOffset = offset + 50;
        return res.json({
            ok: true,
            tracks: { items: simplified },
            nextOffset,
            hasMore: nextOffset < total
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'search');
    }
});

router.get('/recentlyQueued', async (req, res) => {
    if (!req.session?.token?.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT track_uri, track_name, artist_name FROM transactions 
                 WHERE user_id = ? AND action = 'play' 
                 ORDER BY timestamp DESC LIMIT 200`,
                [req.session.token.id],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });

        // Deduplicate: keep only the most recent play of each track, cap at 50
        const seen = new Set();
        const uniqueRows = rows.filter(r => {
            if (seen.has(r.track_uri)) return false;
            seen.add(r.track_uri);
            return true;
        }).slice(0, 50);

        if (uniqueRows.length === 0) {
            return res.json({ ok: true, tracks: [] });
        }

        // Extract track IDs from URIs and batch-fetch from Spotify for album art
        const trackIds = uniqueRows
            .map(r => r.track_uri?.match(/^spotify:track:([a-zA-Z0-9]{22})$/)?.[1])
            .filter(Boolean);

        let imageMap = {};
        if (trackIds.length > 0) {
            try {
                await ensureSpotifyAccessToken();
                const uniqueIds = [...new Set(trackIds)];
                const trackData = await spotifyApi.getTracks(uniqueIds);
                for (const t of trackData.body.tracks) {
                    if (t) imageMap[t.uri] = t.album?.images?.[0]?.url || null;
                }
            } catch (e) {
                console.warn('Could not fetch album art for recent tracks:', e.message);
            }
        }

        const tracks = uniqueRows.map(r => ({
            name: r.track_name || 'Unknown',
            artist: r.artist_name || 'Unknown',
            uri: r.track_uri,
            album: {
                name: '',
                image: imageMap[r.track_uri] || null
            }
        }));

        return res.json({ ok: true, tracks });
    } catch (err) {
        console.error('Error fetching recently queued:', err);
        return res.status(500).json({ ok: false, error: 'Failed to fetch recently queued songs' });
    }
});

router.post('/clearQueueHistory', async (req, res) => {
    if (!req.session?.token?.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        await new Promise((resolve, reject) => {
            db.run(
                `DELETE FROM transactions WHERE user_id = ? AND action = 'play'`,
                [req.session.token.id],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Emit socket event to notify the user their history was cleared
        const io = req.app.get('io');
        if (io) {
            io.to(`user:${req.session.token.id}`).emit('queueHistoryUpdated', { userId: req.session.token.id });
        }

        return res.json({ ok: true, message: 'Queue history cleared' });
    } catch (err) {
        console.error('Error clearing queue history:', err);
        return res.status(500).json({ ok: false, error: 'Failed to clear queue history' });
    }
});

router.get('/api/spotify/playlists', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const classId = getCurrentClassId();
        const playlistData = await spotifyApi.getUserPlaylists({ limit: 50 });
        const items = playlistData.body?.items || [];
        const allowedMap = await getAllowedPlaylistMap(classId);

        const playlists = items.map((playlist) => {
            const formatted = {
            id: playlist.id,
            name: playlist.name || 'Untitled Playlist',
            totalTracks: playlist.tracks?.total ?? 0,
            image: playlist.images?.[0]?.url || null,
            owner: playlist.owner?.display_name || playlist.owner?.id || 'Unknown',
            url: playlist.external_urls?.spotify || null,
            uri: playlist.uri,
            isAllowed: allowedMap.get(playlist.id) || false
            };
            return formatted;
        });

        await Promise.all(playlists.map((playlist) => upsertPlaylistMetadata(playlist, req.session?.token?.id, classId)));

        return res.json({ ok: true, playlists });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch playlists');
    }
});

router.post('/api/spotify/playlists/allow', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { playlistId, name, owner, image, totalTracks } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = getCurrentClassId();
        await upsertPlaylistMetadata({
            id: playlistId,
            name,
            owner,
            image,
            totalTracks
        }, req.session?.token?.id, classId);

        await setPlaylistAllowedState(playlistId, true, req.session?.token?.id, classId);
        return res.json({ ok: true, message: 'Playlist allowed' });
    } catch (err) {
        console.error('Allow playlist error:', err);
        return res.status(500).json({ ok: false, error: 'Failed to allow playlist' });
    }
});

router.post('/api/spotify/playlists/disallow', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = getCurrentClassId();
        const changes = await setPlaylistAllowedState(playlistId, false, req.session?.token?.id, classId);
        if (!changes) {
            return res.status(404).json({ ok: false, error: 'Playlist not found' });
        }

        return res.json({ ok: true, message: 'Playlist disallowed' });
    } catch (err) {
        console.error('Disallow playlist error:', err);
        return res.status(500).json({ ok: false, error: 'Failed to disallow playlist' });
    }
});

router.get('/api/playlists/allowed', isAuthenticated, async (req, res) => {
    try {
        const classId = getCurrentClassId();
        const rows = await getAllowedPlaylists(classId);
        const playlists = rows.map((row) => ({
            id: row.spotify_playlist_id,
            name: row.name || 'Untitled Playlist',
            owner: row.owner_name || 'Unknown',
            image: row.image_url || null,
            totalTracks: Number(row.total_tracks) || 0
        }));

        return res.json({ ok: true, playlists });
    } catch (err) {
        console.error('Get allowed playlists error:', err);
        return res.status(500).json({ ok: false, error: 'Failed to fetch allowed playlists' });
    }
});

router.post('/api/playlists/quote', isAuthenticated, async (req, res) => {
    try {
        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = getCurrentClassId();
        const allowedRow = await getAllowedPlaylist(playlistId, classId);
        if (!allowedRow || !allowedRow.is_allowed) {
            return res.status(403).json({ ok: false, error: 'This playlist is not allowed' });
        }

        const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId);
        if (alreadyPlaying) {
            return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
        }

        await ensureSpotifyAccessToken();
        const [playlistMeta, playlistStats] = await Promise.all([
            spotifyApi.getPlaylist(playlistId),
            getPlaylistPlayableStats(playlistId)
        ]);

        const queueableCount = playlistStats.playableCount;
        const cost = computePlaylistCost(queueableCount);

        return res.json({
            ok: true,
            playlist: {
                id: playlistId,
                name: playlistMeta.body?.name || allowedRow.name || 'Untitled Playlist'
            },
            queueableCount,
            skipped: playlistStats.skipped,
            cost
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'quote playlist');
    }
});

router.post('/api/playlists/queue', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session?.token?.id;
        if (!userId) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }

        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = getCurrentClassId();
        const allowedRow = await getAllowedPlaylist(playlistId, classId);
        if (!allowedRow || !allowedRow.is_allowed) {
            return res.status(403).json({ ok: false, error: 'This playlist is not allowed' });
        }

        const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId);
        if (alreadyPlaying) {
            return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
        }

        const userIsOwner = isOwner(userId);

        if (!userIsOwner) {
            const userBanned = await new Promise((resolve, reject) => {
                db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [userId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row && row.isBanned === 1);
                });
            });
            if (userBanned) {
                return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
            }

            if (!req.session.hasPaid) {
                return res.status(402).json({ ok: false, error: 'Payment required to play playlist' });
            }

            const paidAction = req.session?.payment?.pendingAction;
            const paidPlaylistId = req.session?.payment?.playlistId;
            if (paidAction !== 'playlist' || paidPlaylistId !== playlistId) {
                return res.status(409).json({ ok: false, error: 'Payment is not linked to this playlist' });
            }
        }

        await ensureSpotifyAccessToken();
        const [playlistMeta, playlistStats] = await Promise.all([
            spotifyApi.getPlaylist(playlistId),
            getPlaylistPlayableStats(playlistId)
        ]);

        const queueableCount = playlistStats.playableCount;
        const expectedCost = computePlaylistCost(queueableCount);
        if (!userIsOwner) {
            const paidAmount = Number(req.session?.payment?.amount) || 0;
            if (paidAmount < expectedCost) {
                return res.status(409).json({ ok: false, error: 'Insufficient payment for current playlist contents' });
            }
        }

        if (!queueableCount) {
            return res.status(400).json({ ok: false, error: 'No queueable tracks found in this playlist', skipped: queueData.skipped });
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');
        const playlistUri = playlistMeta.body?.uri || `spotify:playlist:${playlistId}`;

        await spotifyApi.play({ context_uri: playlistUri });

        try {
            await queueManager.syncWithSpotify(spotifyApi);
        } catch (syncErr) {
            console.warn('Playlist playback started but queue sync failed:', syncErr.message);
        }

        if (!userIsOwner) {
            db.run('UPDATE users SET songsPlayed = songsPlayed + ? WHERE id = ?', [queueableCount, userId], (err) => {
                if (err) console.error('Error updating songs played for playlist:', err);
            });
        }

        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'playlist',
            trackURI: playlistMeta.body?.uri || null,
            trackName: playlistMeta.body?.name || allowedRow.name || 'Playlist',
            artistName: `${queueableCount} tracks in playlist`,
            cost: userIsOwner ? 0 : expectedCost
        });

        if (!userIsOwner) {
            req.session.hasPaid = false;
            req.session.payment = null;
        }
        req.session.save(() => {
            res.json({
                ok: true,
                queuedCount: queueableCount,
                skipped: playlistStats.skipped,
                cost: userIsOwner ? 0 : expectedCost,
                message: `Started playlist playback (${queueableCount} tracks)`
            });
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'queue playlist');
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
        const { name, artist, reason, uri } = req.body || {};
        if (!name || !artist) return res.status(400).json({ ok: false, error: 'Missing track name or artist' });

        const banReason = typeof reason === 'string' ? reason.trim() : '';
        if (!banReason) return res.status(400).json({ ok: false, error: 'Ban reason is required' });
        if (banReason.length > 200) return res.status(400).json({ ok: false, error: 'Ban reason must be 200 characters or fewer' });

        const bannedBy = req.session?.token?.id;
        if (!bannedBy) {
            return res.status(401).json({ ok: false, error: 'Missing user token id' });
        }

        // Avoid duplicates
        const alreadyBanned = await isTrackBannedByNameArtist(name, artist);
        if (alreadyBanned) {
            return res.json({ ok: true, message: 'Track already banned' });
        }

        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO banned_songs (track_name, artist_name, track_uri, banned_by, reason) VALUES (?, ?, ?, ?, ?)',
                [name, artist, uri || null, bannedBy, banReason],
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
            const metadataArrayMap = await new Promise((resolve) => {
                if (trackUris.length === 0) {
                    resolve({});
                    return;
                }

                const placeholders = trackUris.map(() => '?').join(',');
                // Fetch added_by, added_at, and is_anon for each track, ordered so oldest is first
                const query = `SELECT track_uri, added_by, added_at, is_anon FROM queue_metadata WHERE track_uri IN (${placeholders}) ORDER BY added_at ASC`;

                db.all(query, trackUris, (err, rows) => {
                    if (err) {
                        console.error('Failed to fetch queue metadata:', err);
                        resolve({});
                    } else {
                        // Build array-based map to correctly handle duplicate URIs in the queue
                        const map = {};
                        if (rows) {
                            rows.forEach(row => {
                                if (!map[row.track_uri]) map[row.track_uri] = [];
                                map[row.track_uri].push({
                                    added_by: row.added_by,
                                    added_at: row.added_at,
                                    is_anon: row.is_anon
                                });
                            });
                        }
                        resolve(map);
                    }
                });
            });

            // Track which metadata entries have been consumed (for duplicate URIs)
            const usedMetaKeys = new Set();

            let simplified = items.map(t => {
                const entries = metadataArrayMap[t.uri] || [];
                let meta = null;
                for (const entry of entries) {
                    const key = `${t.uri}_${entry.added_at}`;
                    if (!usedMetaKeys.has(key)) {
                        meta = entry;
                        usedMetaKeys.add(key);
                        break;
                    }
                }
                if (!meta && entries.length > 0) meta = entries[0];

                let addedBy = meta?.added_by || 'Spotify';
                if (meta?.is_anon === 1 || meta?.is_anon === true) {
                    addedBy = 'Anonymous';
                }
                return {
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
                    addedBy,
                    addedAt: meta?.added_at || 0
                };
            });
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

    if (isOwner(req.session.token.id)) {
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
            const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');
            const isAnon = anonMode ? 1 : 0;

            const trackInfo = {
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                cover: track.album.images[0].url,
                addedBy: username
            };

            await spotifyApi.addToQueue(shouldAprilFool() ? APRIL_FOOLS_URI : uri);

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
                    `INSERT INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon, skip_shields) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                    [track.uri, username, Date.now(), username, isAnon, 0],
                    function (err) {
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

            if (anonMode !== 1 && !isOwner(req.session.token?.id)) {
                db.run(
                    "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session.token?.id],
                    (err) => {
                        if (err) console.error('Error updating songs played:', err);
                    }
                );
            }

            // Log transaction for owners (cost 0)
            await logTransaction({
                userID: req.session.token.id,
                displayName: req.session.user,
                action: 'play',
                trackURI: trackInfo.uri,
                trackName: trackInfo.name,
                artistName: trackInfo.artist,
                cost: 0
            });

            // Notify the queuing user's sockets that their recently queued list changed
            const io = req.app.get('io');
            if (io) {
                io.to(`user:${req.session.token.id}`).emit('recentlyQueuedUpdate', {
                    name: trackInfo.name,
                    artist: trackInfo.artist,
                    uri: trackInfo.uri,
                    album: { name: '', image: trackInfo.cover }
                });
            }

            //console.log(`Add to queue successful for owner (ID: ${req.session.token.id})`);
            res.json({ success: true, message: "Track queued!", trackInfo });
            return;
        } catch (err) {
            console.error('Error in /addToQueue (admin):', err);
            return res.status(500).json({ error: err.message });
        }
    }

    // For non-admin users, check if banned
    const userBanned = await new Promise((resolve, reject) => {
        db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [req.session.token.id], (err, row) => {
            if (err) reject(err);
            else resolve(row && row.isBanned === 1);
        });
    });
    if (userBanned) {
        return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
    }

    // Check for duplicates BEFORE payment (for non-teachers)
    const isTeacher = req.session.permission >= 4 || isOwner(req.session.token.id);
    if (!isTeacher) {
        const { uri } = req.body;
        if (uri) {
            const isDuplicate = queueManager.queue.some(item => item.uri === uri);
            if (isDuplicate) {
                return res.status(400).json({ ok: false, error: 'This song is already in the queue. Please choose a different song.' });
            }
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

        await spotifyApi.addToQueue(shouldAprilFool() ? APRIL_FOOLS_URI : uri);
        const username2 = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');

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
                `INSERT INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon, skip_shields) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [track.uri, username2, Date.now(), username2, isAnon, 0],
                function (err) {
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

        if (anonMode !== 1 && !isOwner(req.session.token?.id)) {
            db.run(
                "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session.token?.id],
                (err) => {
                    if (err) console.error('Error updating songs played:', err);
                }
            );
        }

        // Log the transaction - ALWAYS log, not just when currentTrack exists
        await logTransaction({
            userID: req.session.token.id,
            displayName: req.session.user,
            action: 'play',
            trackURI: trackInfo.uri,
            trackName: trackInfo.name,
            artistName: trackInfo.artist,
            cost: Number(process.env.SONG_AMOUNT) || 50
        });

        // Clear payment flag after successful queue addition
        req.session.hasPaid = false;
        req.session.save(() => {
            // Notify the queuing user's sockets that their recently queued list changed
            const io = req.app.get('io');
            if (io) {
                io.to(`user:${req.session.token.id}`).emit('recentlyQueuedUpdate', {
                    name: trackInfo.name,
                    artist: trackInfo.artist,
                    uri: trackInfo.uri,
                    album: { name: '', image: trackInfo.cover }
                });
            }
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

    const { uri } = req.body;
    const trackUri = uri; // URI of the currently playing track sent from frontend

    console.log('=== SKIP REQUEST ===');
    console.log('Track URI:', trackUri);
    console.log('User ID:', req.session.token.id);
    console.log('User:', req.session.user);

    if (isOwner(req.session.token.id)) {
        console.log('Owner detected - checking for shields');
        try {
            await ensureSpotifyAccessToken();

            // Owner can skip, but still need to decrement shields if present
            if (trackUri) {
                console.log('Querying database for shields on:', trackUri);
                // Check for skip shields
                const trackMetadata = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT skip_shields FROM queue_metadata WHERE track_uri = ?',
                        [trackUri],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                // If shields exist, decrement but still allow skip (owner bypass)
                console.log('Track metadata:', trackMetadata);
                if (trackMetadata && trackMetadata.skip_shields > 0) {
                    const remainingShields = trackMetadata.skip_shields - 1;
                    console.log(`SHIELD FOUND: ${trackMetadata.skip_shields} shields on track`);
                    console.log('Decrementing shield count...');

                    await new Promise((resolve, reject) => {
                        db.run(
                            'UPDATE queue_metadata SET skip_shields = skip_shields - 1 WHERE track_uri = ?',
                            [trackUri],
                            (err) => {
                                if (err) reject(err);
                                else resolve();
                            }
                        );
                    });

                    console.log(`Owner skip - shield decremented. ${remainingShields} remaining`);
                } else {
                    console.log('No shields found on track (owner skip)');
                }
            }

            await spotifyApi.skipToNext();

            // Update queueManager and broadcast to clients
            const nextTrack = await queueManager.skipTrack(req.session.user || 'Teacher');
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

    // For non-admin users, check if banned
    const skipUserBanned = await new Promise((resolve, reject) => {
        db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [req.session.token.id], (err, row) => {
            if (err) reject(err);
            else resolve(row && row.isBanned === 1);
        });
    });
    if (skipUserBanned) {
        return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
    }

    // For non-admin users, check payment and claim it
    if (!req.session.hasPaid) {
        //console.log('skip - Payment required. User ID:', req.session.token.id, 'hasPaid:', req.session.hasPaid);
        return res.status(403).json({ ok: false, error: 'Payment required to skip' });
    }

    try {
        console.log('Regular user skip - payment confirmed');
        await ensureSpotifyAccessToken();

        // Check if the track being skipped has skip shields
        if (trackUri) {
            console.log('Querying database for shields on:', trackUri);
            // Query database for skip shields
            const trackMetadata = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT skip_shields FROM queue_metadata WHERE track_uri = ?',
                    [trackUri],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            console.log('Track metadata:', trackMetadata);
            // If track has skip shields, block the skip and decrement shield count
            if (trackMetadata && trackMetadata.skip_shields > 0) {
                console.log(`SHIELD DETECTED: ${trackMetadata.skip_shields} shields - BLOCKING SKIP`);
                console.log('User will be charged but skip will be blocked');
                const shieldsThatBlockedSkip = trackMetadata.skip_shields;
                const remainingShields = trackMetadata.skip_shields - 1;
                console.log(`Decrementing shield: ${trackMetadata.skip_shields} -> ${remainingShields}`);

                // Decrement shield count
                await new Promise((resolve, reject) => {
                    db.run(
                        'UPDATE queue_metadata SET skip_shields = skip_shields - 1 WHERE track_uri = ?',
                        [trackUri],
                        (err) => {
                            if (err) reject(err);
                            else resolve();
                        }
                    );
                });
                console.log('Shield decremented in database');

                // Play random blocked sound
                const soundFile = playRandomBlockedSound();

                // Get track details for logging
                const currentPlayback = await spotifyApi.getMyCurrentPlayingTrack();
                const trackName = currentPlayback.body?.item?.name || 'Unknown';
                const artistName = currentPlayback.body?.item?.artists?.map(a => a.name).join(', ') || 'Unknown';

                // Log the blocked skip transaction
                await logTransaction({
                    userID: req.session.token.id,
                    displayName: req.session.user,
                    action: 'skip_blocked',
                    trackURI: trackUri,
                    trackName: trackName,
                    artistName: artistName,
                    cost: Number(process.env.SKIP_AMOUNT) || 100
                });

                // Clear payment flag (they still paid but skip was blocked)
                req.session.hasPaid = false;

                // Broadcast updated queue to refresh shield count
                await queueManager.syncWithSpotify(spotifyApi);
                const skipEvent = {
                    skippedBy: req.session.user || 'Someone',
                    skippedAt: Date.now(),
                    skippedType: 'shield',
                    skippedTrack: { name: trackName }
                };

                try {
                    await logSkipActivity(skipEvent);
                } catch (activityError) {
                    console.error('Failed to persist shield skip activity:', activityError.message);
                }

                queueManager.broadcastUpdate('skip', skipEvent);

                console.log('Returning shield blocked response to client');
                console.log(`Played sound: ${soundFile}`);
                return req.session.save(() => {
                    res.json({
                        ok: false,
                        shieldBlocked: true,
                        remaining: remainingShields,
                        soundPlayed: soundFile,
                        message: `SKIP BLOCKED! This song is protected by ${shieldsThatBlockedSkip} shield${shieldsThatBlockedSkip !== 1 ? 's' : ''}. You were charged ${process.env.SKIP_AMOUNT || 100} digipogs.`
                    });
                });
            } else {
                console.log('No shields found - proceeding with skip');
            }
        } else {
            console.log('No track URI provided - proceeding with skip anyway');
        }

        // No shields, proceed with skip
        await spotifyApi.skipToNext();

        // Update queueManager and broadcast to clients
        const nextTrack = await queueManager.skipTrack(req.session.user || 'Someone');

        if (currentTrack) {
            await logTransaction({
                userID: req.session.token.id,
                displayName: req.session.user,
                action: 'skip',
                trackURI: currentTrack.uri,
                trackName: currentTrack.name,
                artistName: currentTrack.artist,
                cost: Number(process.env.SKIP_AMOUNT) || 100
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

        const username3 = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');

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
        if (req.session.permission < 4 && !isOwner(req.session.token?.id)) {
            return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
        }

        const nextTrack = await queueManager.skipTrack(req.session.user || 'Teacher');

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

// Check if track exists in queue or is currently playing
router.post('/checkTrackExists', isAuthenticated, async (req, res) => {
    const { trackUri } = req.body;
    const db = require('../utils/database');
    const queueManager = require('../utils/queueManager');

    try {
        // Check if it's currently playing
        const state = queueManager.getCurrentState();
        const currentTrack = state.currentTrack;
        const isCurrentlyPlaying = currentTrack && currentTrack.uri === trackUri;

        // Check if track exists in queue metadata
        const track = await new Promise((resolve, reject) => {
            db.get("SELECT track_uri FROM queue_metadata WHERE track_uri = ?", [trackUri], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        // Track exists if it's currently playing OR in the queue
        res.json({ exists: isCurrentlyPlaying || !!track });
    } catch (error) {
        console.error('Error checking track existence:', error);
        res.status(500).json({ exists: false, error: 'Server error' });
    }
});

router.post('/purchaseShield', isAuthenticated, async (req, res) => {
    console.log('=== PURCHASE SHIELD REQUEST ===');
    const { trackUri } = req.body;
    const quantity = Math.max(1, Math.min(1000, parseInt(req.body.quantity) || 1));
    const userId = req.session.token?.id;
    const displayName = req.session.user;

    console.log('Request body:', req.body);
    console.log('User ID:', userId);
    console.log('Display name:', displayName);
    console.log('Track URI:', trackUri);

    // Validation: Check authentication
    if (!userId || !displayName) {
        console.error('User not properly authenticated');
        return res.status(401).json({ ok: false, error: 'User not authenticated' });
    }

    // Validation: Check track URI
    if (!trackUri) {
        console.error('Track URI missing from request');
        return res.status(400).json({ ok: false, error: 'Track URI is required' });
    }

    // Owner bypass - they can add shields for free
    const userIsOwner = isOwner(userId);
    console.log('Is owner:', userIsOwner, '(userId:', userId, ')');

    // Check if user is banned (non-owners only)
    if (!userIsOwner) {
        const shieldUserBanned = await new Promise((resolve, reject) => {
            db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row && row.isBanned === 1);
            });
        });
        if (shieldUserBanned) {
            return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
        }
    }

    // Check payment FIRST before touching anything else
    if (!userIsOwner) {
        if (!req.session.hasPaid) {
            console.error('Payment required but not received');
            return res.status(402).json({ ok: false, error: 'Payment required' });
        }
        console.log('Payment verified');
    } else {
        console.log('Owner bypass - no payment required');
    }

    // Helper: consume hasPaid and attempt an automatic refund, then respond with the error
    const failAndConsume = async (statusCode, payload) => {
        req.session.hasPaid = false;
        const lastPayment = req.session.payment;
        const pin = process.env.PIN;
        if (lastPayment && !lastPayment.refundedAt && lastPayment.amount > 0 && pin != null) {
            try {
                await poolRefund({
                    from: Number(lastPayment.to),
                    to: Number(lastPayment.from),
                    amount: Number(lastPayment.amount),
                    pin: Number(pin),
                    reason: 'Jukebar refund - shield purchase failed'
                });
                req.session.payment.refundedAt = Date.now();
                console.log('[purchaseShield] Auto-refund issued for failed shield purchase');
            } catch (refundErr) {
                console.error('[purchaseShield] Auto-refund failed:', refundErr.message);
            }
        }
        return req.session.save(() => res.status(statusCode).json(payload));
    };

    try {
        // Step 1: Verify track exists in queue
        console.log('Step 1: Checking if track exists in queue...');
        let track = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM queue_metadata WHERE track_uri = ?" + (req.body.addedAt && req.body.addedAt !== '0' ? " AND added_at = ?" : ""),
                req.body.addedAt && req.body.addedAt !== '0' ? [trackUri, req.body.addedAt] : [trackUri],
                (err, row) => {
                    if (err) {
                        console.error('Database error querying queue_metadata:', err);
                        reject(err);
                    } else {
                        console.log('Track found in queue:', row);
                        resolve(row);
                    }
                });
        });

        // If not found in queue, try to find currently playing track's metadata
        if (!track) {
            console.warn('Track not found in queue, checking currently playing...');
            const queueManager = require('../utils/queueManager');
            const state = queueManager.getCurrentState();
            const currentTrack = state.currentTrack;
            if (currentTrack && currentTrack.uri === trackUri) {
                // Find the metadata entry for the currently playing track (oldest matching entry)
                track = await new Promise((resolve, reject) => {
                    db.get("SELECT * FROM queue_metadata WHERE track_uri = ? ORDER BY added_at ASC LIMIT 1", [trackUri], (err, row) => {
                        if (err) {
                            console.error('Database error querying current track metadata:', err);
                            reject(err);
                        } else {
                            console.log('Track found for currently playing:', row);
                            resolve(row);
                        }
                    });
                });
                // If found, update shields for this metadata entry
                if (track) {
                    const updateResult = await new Promise((resolve, reject) => {
                        db.run("UPDATE queue_metadata SET skip_shields = COALESCE(skip_shields, 0) + ? WHERE track_uri = ? AND added_at = ?", [quantity, trackUri, track.added_at], function (err) {
                            if (err) {
                                console.error('Database error updating shields for current track:', err);
                                reject(err);
                            } else {
                                console.log('Shield count incremented for currently playing track at', track.added_at, '. Rows affected:', this.changes);
                                resolve(this.changes);
                            }
                        });
                    });
                    if (updateResult === 0) {
                        console.error('No rows updated for currently playing track');
                        return failAndConsume(404, { ok: false, error: 'Track no longer in queue or playing' });
                    }
                } else {
                    // No metadata entry exists for the currently playing track — create one with shields
                    console.log('No metadata entry for currently playing track, creating one with', quantity, 'shields');
                    const nowTs = Date.now();
                    await new Promise((resolve, reject) => {
                        db.run(
                            `INSERT INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon, skip_shields) VALUES (?, ?, ?, ?, ?, ?)`,
                            [trackUri, currentTrack.addedBy || 'spotify', nowTs, currentTrack.displayName || 'Spotify', currentTrack.isAnon ? 1 : 0, quantity],
                            function (err) {
                                if (err) {
                                    console.error('Database error inserting metadata for current track:', err);
                                    reject(err);
                                } else {
                                    console.log('Created metadata entry for currently playing track with', quantity, 'shields');
                                    resolve(this.changes);
                                }
                            }
                        );
                    });
                    track = {
                        track_uri: trackUri,
                        added_by: currentTrack.addedBy || 'spotify',
                        added_at: nowTs,
                        display_name: currentTrack.displayName || 'Spotify',
                        is_anon: currentTrack.isAnon ? 1 : 0,
                        skip_shields: quantity
                    };
                }
            } else {
                console.error('Track not found in queue or as currently playing');
                return failAndConsume(404, { ok: false, error: 'Track not found in queue or playing' });
            }
        } else {
            console.log('Track found:', track.track_name, 'by', track.artist_name);

            // Check if track already has 1000 shields
            const currentShields = track.skip_shields || 0;
            if (currentShields >= 1000) {
                console.log('Track already has max shields (1000)');
                return failAndConsume(400, { ok: false, error: 'This song already has the maximum of 1000 shields and cannot have more added' });
            }

            // Check if adding the requested quantity would exceed 1000
            if (currentShields + quantity > 1000) {
                const availableSlots = 1000 - currentShields;
                console.log(`Cannot add ${quantity} shields; only ${availableSlots} slots available`);
                return failAndConsume(400, { ok: false, error: `This song already has ${currentShields} shields. You can only add ${availableSlots} more to reach the maximum of 1000` });
            }

            // Step 2: Update shield count for specific track instance
            console.log('Step 2: Incrementing shield count...');
            const addedAt = req.body.addedAt;
            const updateResult = await new Promise((resolve, reject) => {
                const query = addedAt && addedAt !== '0'
                    ? "UPDATE queue_metadata SET skip_shields = COALESCE(skip_shields, 0) + ? WHERE track_uri = ? AND added_at = ?"
                    : "UPDATE queue_metadata SET skip_shields = COALESCE(skip_shields, 0) + ? WHERE track_uri = ?";
                const params = addedAt && addedAt !== '0' ? [quantity, trackUri, addedAt] : [quantity, trackUri];
                db.run(query, params, function (err) {
                    if (err) {
                        console.error('Database error updating shields:', err);
                        reject(err);
                    } else {
                        console.log('Shield count incremented for track at', addedAt || 'first instance', '. Rows affected:', this.changes);
                        resolve(this.changes);
                    }
                });
            });

            if (updateResult === 0) {
                console.error('No rows updated - track may have been removed from queue');
                return failAndConsume(404, { ok: false, error: 'Track no longer in queue' });
            }
        }

        // Step 3: Log transaction
        console.log('Step 3: Logging transaction...');
        try {
            await logTransaction({
                userID: userId,
                displayName: displayName,
                action: 'shield',
                trackURI: trackUri,
                trackName: track.track_name,
                artistName: track.artist_name,
                cost: userIsOwner ? 0 : (Number(process.env.SKIP_SHIELD_AMOUNT) || 75) * quantity
            });
            console.log('Transaction logged');
        } catch (logErr) {
            console.error('WARNING: Failed to log transaction (non-fatal):', logErr);
            // Continue anyway - shield was added
        }

        // Step 4: Clear payment flag for non-owner
        if (!userIsOwner) {
            console.log('Step 4: Clearing payment flag...');
            req.session.hasPaid = false;
            console.log('Payment flag cleared');
        }

        // Step 5: Broadcast queue update
        console.log('Step 5: Broadcasting queue update...');
        try {
            // Force re-sync from Spotify to get updated metadata
            await queueManager.syncWithSpotify(spotifyApi);
            console.log('Queue synced and broadcasted');
        } catch (broadcastErr) {
            console.error('WARNING: Failed to sync queue (non-fatal):', broadcastErr);
            // Continue anyway - shield was added
        }

        // Step 6: Save session and respond
        console.log('Step 6: Saving session and responding...');
        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('WARNING: Session save error (non-fatal):', saveErr);
            }
            console.log('Shield purchase complete!');
            console.log('================================');
            res.json({ ok: true, message: `${quantity > 1 ? quantity + ' shields' : 'Shield'} added successfully` });
        });

    } catch (error) {
        console.error('FATAL ERROR in purchaseShield:', error);
        console.error('Error stack:', error.stack);
        console.log('================================');
        res.status(500).json({ ok: false, error: 'Server error', details: error.message });
    }
});


router.get('/api/currentTrack', async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        });
        const data = await response.json();
        res.json({ track: data.item });
    } catch (err) {
        console.error('Error fetching current track:', err);
        res.status(500).json({ error: 'Failed to fetch current track' });
    }
});

module.exports = router;
