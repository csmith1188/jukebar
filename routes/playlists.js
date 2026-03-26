const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { isAuthenticated } = require('../middleware/auth');
const { isOwner } = require('../utils/owners');
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const { logTransaction } = require('./logging');

function requireTeacherAccess(req, res, next) {
    const userId = req.session?.token?.id;
    const hasPermission = (req.session?.permission || 0) >= 4;
    if (hasPermission || isOwner(userId)) {
        return next();
    }
    return res.status(403).json({ ok: false, error: 'Teacher access required' });
}

function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function calculatePlaylistCost(totalDurationMs) {
    const perMinute = Number(process.env.PLAYLIST_COST_PER_MINUTE) || Number(process.env.SONG_AMOUNT) || 50;
    const minCost = Number(process.env.PLAYLIST_MIN_COST) || 0;
    const maxCost = Number(process.env.PLAYLIST_MAX_COST) || 0;

    const minutes = Math.max(1, Math.ceil((Number(totalDurationMs) || 0) / 60000));
    let cost = minutes * perMinute;

    if (minCost > 0) cost = Math.max(cost, minCost);
    if (maxCost > 0) cost = Math.min(cost, maxCost);

    return cost;
}

async function getAllPlaylistTrackItems(playlistId) {
    const allItems = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const resp = await spotifyApi.getPlaylistTracks(playlistId, {
            fields: 'items(track(uri,duration_ms)),next',
            limit,
            offset
        });

        const body = resp.body || {};
        const items = body.items || [];
        allItems.push(...items);

        if (!body.next || items.length === 0) break;
        offset += items.length;
    }

    return allItems;
}

async function syncPlaylistsFromSpotify() {
    await ensureSpotifyAccessToken();

    let offset = 0;
    const limit = 50;
    let fetchedAny = false;

    while (true) {
        const resp = await spotifyApi.getUserPlaylists({ limit, offset });
        const body = resp.body || {};
        const items = body.items || [];
        if (items.length === 0) break;

        fetchedAny = true;

        for (const playlist of items) {
            const playlistId = playlist.id;
            const name = playlist.name || 'Untitled Playlist';
            const imageUrl = playlist.images?.[0]?.url || null;
            const ownerName = playlist.owner?.display_name || playlist.owner?.id || null;

            const tracks = await getAllPlaylistTrackItems(playlistId);
            const trackCount = tracks.length;
            const totalDurationMs = tracks.reduce((sum, item) => {
                return sum + (item?.track?.duration_ms || 0);
            }, 0);

            await dbRun(
                `INSERT INTO spotify_playlists
                    (spotify_playlist_id, name, image_url, owner_name, enabled_for_students, track_count, total_duration_ms, last_synced_at)
                 VALUES (?, ?, ?, ?, COALESCE((SELECT enabled_for_students FROM spotify_playlists WHERE spotify_playlist_id = ?), 0), ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(spotify_playlist_id)
                 DO UPDATE SET
                    name = excluded.name,
                    image_url = excluded.image_url,
                    owner_name = excluded.owner_name,
                    track_count = excluded.track_count,
                    total_duration_ms = excluded.total_duration_ms,
                    last_synced_at = CURRENT_TIMESTAMP`,
                [playlistId, name, imageUrl, ownerName, playlistId, trackCount, totalDurationMs]
            );
        }

        if (!body.next) break;
        offset += items.length;
    }

    return fetchedAny;
}

router.get('/api/playlists', isAuthenticated, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT spotify_playlist_id, name, image_url, owner_name, enabled_for_students, track_count, total_duration_ms
             FROM spotify_playlists
             WHERE enabled_for_students = 1
             ORDER BY name COLLATE NOCASE ASC`
        );

        const playlists = rows.map((row) => ({
            ...row,
            cost_digipogs: calculatePlaylistCost(row.total_duration_ms)
        }));

        res.json({ ok: true, playlists });
    } catch (error) {
        console.error('Error fetching student playlists:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch playlists' });
    }
});

router.get('/api/playlists/teacher', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT spotify_playlist_id, name, image_url, owner_name, enabled_for_students, track_count, total_duration_ms, last_synced_at
             FROM spotify_playlists
             ORDER BY name COLLATE NOCASE ASC`
        );

        const playlists = rows.map((row) => ({
            ...row,
            cost_digipogs: calculatePlaylistCost(row.total_duration_ms)
        }));

        res.json({ ok: true, playlists });
    } catch (error) {
        console.error('Error fetching teacher playlists:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch playlists' });
    }
});

router.post('/api/playlists/refresh', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        await syncPlaylistsFromSpotify();
        res.json({ ok: true, message: 'Playlists refreshed' });
    } catch (error) {
        console.error('Error refreshing playlists:', error?.message || error);
        res.status(500).json({ ok: false, error: 'Failed to refresh playlists' });
    }
});

router.post('/api/playlists/:id/enable', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const playlistId = req.params.id;
        const result = await dbRun('UPDATE spotify_playlists SET enabled_for_students = 1 WHERE spotify_playlist_id = ?', [playlistId]);
        if (!result.changes) {
            return res.status(404).json({ ok: false, error: 'Playlist not found' });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('Error enabling playlist:', error);
        res.status(500).json({ ok: false, error: 'Failed to enable playlist' });
    }
});

router.post('/api/playlists/:id/disable', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const playlistId = req.params.id;
        const result = await dbRun('UPDATE spotify_playlists SET enabled_for_students = 0 WHERE spotify_playlist_id = ?', [playlistId]);
        if (!result.changes) {
            return res.status(404).json({ ok: false, error: 'Playlist not found' });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('Error disabling playlist:', error);
        res.status(500).json({ ok: false, error: 'Failed to disable playlist' });
    }
});

router.get('/api/playlists/balance', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session?.token?.id;
        const user = await dbGet('SELECT id, COALESCE(digipogs, 0) AS digipogs FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        }
        res.json({ ok: true, digipogs: Number(user.digipogs) || 0 });
    } catch (error) {
        console.error('Error getting balance:', error);
        res.status(500).json({ ok: false, error: 'Failed to get balance' });
    }
});

router.post('/api/playlists/:id/play', isAuthenticated, async (req, res) => {
    const playlistId = req.params.id;
    const userId = req.session?.token?.id;

    try {
        const user = await dbGet(
            'SELECT id, displayName, COALESCE(digipogs, 0) as digipogs, COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?',
            [userId]
        );

        if (!user) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        }

        if (Number(user.isBanned) === 1) {
            return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
        }

        const playlist = await dbGet(
            `SELECT spotify_playlist_id, name, enabled_for_students, total_duration_ms
             FROM spotify_playlists
             WHERE spotify_playlist_id = ?`,
            [playlistId]
        );

        if (!playlist) {
            return res.status(404).json({ ok: false, error: 'Playlist not found' });
        }

        const isTeacher = (req.session?.permission || 0) >= 4 || isOwner(userId);
        if (!isTeacher && Number(playlist.enabled_for_students) !== 1) {
            return res.status(403).json({ ok: false, error: 'Playlist is not available for students' });
        }

        const cost = isTeacher ? 0 : calculatePlaylistCost(playlist.total_duration_ms);

        if (!isTeacher && Number(user.digipogs) < cost) {
            return res.status(400).json({ ok: false, error: 'Not enough digipogs' });
        }

        if (!isTeacher && cost > 0) {
            const debit = await dbRun(
                'UPDATE users SET digipogs = digipogs - ? WHERE id = ? AND digipogs >= ?',
                [cost, userId, cost]
            );

            if (!debit.changes) {
                return res.status(400).json({ ok: false, error: 'Not enough digipogs' });
            }
        }

        try {
            await ensureSpotifyAccessToken();
            await spotifyApi.play({ context_uri: `spotify:playlist:${playlistId}` });
        } catch (playError) {
            if (!isTeacher && cost > 0) {
                await dbRun('UPDATE users SET digipogs = digipogs + ? WHERE id = ?', [cost, userId]);
            }
            throw playError;
        }

        await logTransaction({
            userID: Number(userId),
            displayName: user.displayName || 'Unknown User',
            action: 'playlist_play',
            trackURI: `spotify:playlist:${playlistId}`,
            trackName: playlist.name || 'Playlist',
            artistName: null,
            cost
        });

        const updatedUser = await dbGet('SELECT COALESCE(digipogs, 0) as digipogs FROM users WHERE id = ?', [userId]);

        res.json({
            ok: true,
            message: 'Playlist started',
            cost,
            digipogs: Number(updatedUser?.digipogs) || 0
        });
    } catch (error) {
        console.error('Error playing playlist:', error?.message || error);
        res.status(500).json({ ok: false, error: 'Failed to play playlist' });
    }
});

module.exports = router;
