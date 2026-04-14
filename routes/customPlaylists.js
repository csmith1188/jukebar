const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const { isOwner } = require('../utils/owners');
const { logTransaction } = require('./logging');
const { isAuthenticated } = require('../middleware/auth');
const { getCurrentClassId, requestAndWaitForClassId } = require('./socket');
const queueManager = require('../utils/queueManager');

async function getClassId() {
    const cached = getCurrentClassId();
    if (cached !== null && cached !== undefined) return cached;
    const fetched = await requestAndWaitForClassId();
    return fetched ?? null;
}

const CREATE_PLAYLIST_AMOUNT = () => Number(process.env.CREATE_PLAYLIST_AMOUNT) || 700;
const ADD_PLAYLIST_SONG_AMOUNT = () => Number(process.env.ADD_PLAYLIST_SONG_AMOUNT) || 100;
const REMOVE_PLAYLIST_SONG_AMOUNT = () => Number(process.env.REMOVE_PLAYLIST_SONG_AMOUNT) || 50;
const CUSTOM_PLAYLIST_PLAY_AMOUNT = () => Number(process.env.CUSTOM_PLAYLIST_PLAY_AMOUNT) || 250;
const INITIAL_FREE_SONGS = 5;

function isValidTrackUri(uri) {
    return typeof uri === 'string' && /^spotify:track:[a-zA-Z0-9]{22}$/.test(uri);
}

function extractTrackId(uri) {
    return uri.replace('spotify:track:', '');
}

function getBannedSongs() {
    return new Promise((resolve, reject) => {
        db.all('SELECT track_name, artist_name FROM banned_songs', (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function getUserBanned(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row && row.isBanned === 1);
        });
    });
}

// Validate that track URIs are real, non-explicit, and not banned
async function validateTrackUris(uris) {
    if (!Array.isArray(uris) || uris.length === 0) return { valid: true };

    for (const uri of uris) {
        if (!isValidTrackUri(uri)) {
            return { valid: false, error: `Invalid track URI: ${uri}` };
        }
    }

    await ensureSpotifyAccessToken();
    const ids = uris.map(extractTrackId);
    const res = await spotifyApi.getTracks(ids);
    const tracks = res.body.tracks || [];

    const bannedSongs = await getBannedSongs();
    const bannedPairs = new Set(
        bannedSongs.map(b => `${(b.track_name || '').trim().toLowerCase()}::${(b.artist_name || '').trim().toLowerCase()}`)
    );

    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (!track) return { valid: false, error: `Track not found: ${uris[i]}` };
        if (track.explicit) return { valid: false, error: `"${track.name}" is explicit and cannot be added` };

        const name = (track.name || '').trim().toLowerCase();
        const artist = (track.artists || []).map(a => a.name).join(', ').trim().toLowerCase();
        if (bannedPairs.has(`${name}::${artist}`)) {
            return { valid: false, error: `"${track.name}" is banned` };
        }
    }

    return { valid: true };
}

function getCustomPlaylist(playlistDbId, userId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT id, spotify_playlist_id, name, song_count, image_url, user_id FROM custom_playlists WHERE id = ?',
            [playlistDbId],
            (err, row) => {
                if (err) return reject(err);
                // Return null if not found or not owned — caller returns 403 (don't leak IDs)
                if (!row || row.user_id !== Number(userId)) return resolve(null);
                resolve(row);
            }
        );
    });
}

function getCustomPlaylistForClass(playlistDbId, classId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT id, spotify_playlist_id, name, song_count, image_url, user_id, class_id FROM custom_playlists WHERE id = ? AND class_id IS ?',
            [playlistDbId, classId],
            (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            }
        );
    });
}

function isSpotifyNotFoundError(err) {
    return err?.statusCode === 404 || err?.body?.error?.status === 404;
}

async function getCurrentSpotifyUserId() {
    await ensureSpotifyAccessToken();
    const me = await spotifyApi.getMe();
    return me.body?.id || null;
}

async function isPlaylistInCurrentUsersLibrary(playlistOwnerId, playlistId, spotifyUserId) {
    if (!playlistId) return false;
    if (!playlistOwnerId) return true;
    const currentSpotifyUserId = spotifyUserId || await getCurrentSpotifyUserId();
    if (!currentSpotifyUserId) return false;

    const followsRes = await spotifyApi.areFollowingPlaylist(playlistOwnerId, playlistId, [currentSpotifyUserId]);
    return Boolean(Array.isArray(followsRes.body) ? followsRes.body[0] : false);
}

function deleteCustomPlaylistById(playlistDbId) {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM custom_playlists WHERE id = ?', [playlistDbId], function (err) {
            if (err) return reject(err);
            resolve(this.changes || 0);
        });
    });
}

function updateCustomPlaylistImage(playlistDbId, imageUrl) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE custom_playlists SET image_url = ? WHERE id = ?', [imageUrl || null, playlistDbId], (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

async function ensureCustomPlaylistExistsOrCleanup(playlistRow, options = {}) {
    if (!playlistRow?.spotify_playlist_id) {
        return { exists: false, deleted: true, imageUrl: null };
    }

    await ensureSpotifyAccessToken();
    try {
        const playlistMeta = await spotifyApi.getPlaylist(playlistRow.spotify_playlist_id, { fields: 'id,images,owner(id)' });
        const playlistOwnerId = playlistMeta.body?.owner?.id || null;
        const inLibrary = await isPlaylistInCurrentUsersLibrary(playlistOwnerId, playlistRow.spotify_playlist_id, options.spotifyUserId);
        if (!inLibrary) {
            await deleteCustomPlaylistById(playlistRow.id);
            return { exists: false, deleted: true, imageUrl: null };
        }

        const imageUrl = playlistMeta.body?.images?.[0]?.url || null;

        if ((playlistRow.image_url || null) !== imageUrl) {
            await updateCustomPlaylistImage(playlistRow.id, imageUrl);
        }

        return { exists: true, deleted: false, imageUrl };
    } catch (err) {
        if (isSpotifyNotFoundError(err)) {
            await deleteCustomPlaylistById(playlistRow.id);
            return { exists: false, deleted: true, imageUrl: null };
        }
        throw err;
    }
}

// GET /api/custom-playlists — list custom playlists for the caller's current class
router.get('/api/custom-playlists', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
        const classId = await getClassId();
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT cp.id, cp.spotify_playlist_id, cp.name, cp.song_count, cp.image_url, cp.created_at, cp.user_id,
                        COALESCE(u.displayName, 'Unknown') as owner_name
                 FROM custom_playlists cp
                 LEFT JOIN users u ON u.id = cp.user_id
                 WHERE cp.class_id IS ?
                 ORDER BY cp.created_at DESC`,
                [classId],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });
        const spotifyUserId = await getCurrentSpotifyUserId();
        const checkedRows = await Promise.all(rows.map(async (row) => {
            try {
                const check = await ensureCustomPlaylistExistsOrCleanup(row, { spotifyUserId });
                if (!check.exists) return null;
                return {
                    ...row,
                    image_url: check.imageUrl || row.image_url || null,
                    is_owner: Number(row.user_id) === Number(userId)
                };
            } catch (verifyErr) {
                console.warn('[custom-playlists:list] verify failed for row', row.id, verifyErr.message);
                return {
                    ...row,
                    is_owner: Number(row.user_id) === Number(userId)
                };
            }
        }));

        res.json({ ok: true, playlists: checkedRows.filter(Boolean) });
    } catch (err) {
        console.error('[custom-playlists:list]', err);
        res.status(500).json({ ok: false, error: 'Failed to load playlists' });
    }
});

// POST /api/custom-playlists/create — create a playlist with a name + up to 5 initial songs
router.post('/api/custom-playlists/create', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const userIsOwner = isOwner(userId);

    if (!userIsOwner) {
        if (!req.session.hasPaid) {
            return res.status(402).json({ ok: false, error: 'Payment required to create a playlist' });
        }
        if (req.session?.payment?.pendingAction !== 'createPlaylist') {
            return res.status(409).json({ ok: false, error: 'Payment is not linked to playlist creation' });
        }
    }

    const userBanned = await getUserBanned(userId).catch(() => false);
    if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

    const { name, trackUris = [] } = req.body || {};

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length > 100) {
        return res.status(400).json({ ok: false, error: 'Playlist name must be between 1 and 100 characters' });
    }

    if (!Array.isArray(trackUris) || trackUris.length > INITIAL_FREE_SONGS) {
        return res.status(400).json({ ok: false, error: `You can add up to ${INITIAL_FREE_SONGS} songs on creation` });
    }

    try {
        const trackValidation = await validateTrackUris(trackUris);
        if (!trackValidation.valid) {
            return res.status(400).json({ ok: false, error: trackValidation.error });
        }

        await ensureSpotifyAccessToken();
        const accessToken = spotifyApi.getAccessToken();

        const meRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!meRes.ok) throw new Error(`getMe failed: ${meRes.status}`);
        const meData = await meRes.json();
        const spotifyUserId = meData.id;

        const classId = await getClassId();

        const createRes = await fetch(`https://api.spotify.com/v1/users/${spotifyUserId}/playlists`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmedName, public: false, description: 'Custom playlist created via Jukebar' })
        });
        if (!createRes.ok) throw new Error(`createPlaylist failed: ${createRes.status}`);
        const createData = await createRes.json();
        const spotifyPlaylistId = createData.id;
        let playlistImageUrl = createData.images?.[0]?.url || null;

        if (trackUris.length > 0) {
            const addRes = await fetch(`https://api.spotify.com/v1/playlists/${spotifyPlaylistId}/tracks`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: trackUris })
            });
            if (!addRes.ok) throw new Error(`addTracks failed: ${addRes.status}`);
        }

        if (!playlistImageUrl && spotifyPlaylistId) {
            try {
                const playlistMeta = await spotifyApi.getPlaylist(spotifyPlaylistId);
                playlistImageUrl = playlistMeta.body?.images?.[0]?.url || null;
            } catch (coverErr) {
                console.warn('[custom-playlists:create] could not fetch playlist cover:', coverErr.message);
            }
        }

        const dbId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO custom_playlists (user_id, class_id, spotify_playlist_id, name, song_count, image_url) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, classId, spotifyPlaylistId, trimmedName, trackUris.length, playlistImageUrl],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });

        if (!userIsOwner) {
            req.session.hasPaid = false;
            req.session.payment = null;
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'createPlaylist',
            trackURI: null,
            trackName: trimmedName,
            artistName: `${trackUris.length} initial track(s)`,
            cost: userIsOwner ? 0 : CREATE_PLAYLIST_AMOUNT()
        }).catch(err => console.error('[custom-playlists:create] log failed:', err));

        req.session.save(() => {
            res.json({
                ok: true,
                playlist: {
                    id: dbId,
                    spotifyPlaylistId,
                    name: trimmedName,
                    songCount: trackUris.length,
                    image: playlistImageUrl
                }
            });
        });
    } catch (err) {
        console.error('[custom-playlists:create]', err);
        res.status(500).json({ ok: false, error: 'Failed to create playlist' });
    }
});

// GET /api/custom-playlists/:id/tracks — fetch tracks for a custom playlist
router.get('/api/custom-playlists/:id/tracks', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const playlistDbId = parseInt(req.params.id);
    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });

    try {
        const classId = await getClassId();
        const playlist = await getCustomPlaylistForClass(playlistDbId, classId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        await ensureSpotifyAccessToken();
        const tracks = [];
        let offset = 0;
        const limit = 100;

        while (true) {
            const response = await spotifyApi.getPlaylistTracks(playlist.spotify_playlist_id, { limit, offset });
            const items = response.body?.items || [];
            tracks.push(...items.filter(item => item?.track && !item.track.is_local && item.track.uri?.startsWith('spotify:track:')));
            if (items.length < limit) break;
            offset += limit;
        }

        const simplified = tracks.map(item => ({
            uri: item.track.uri,
            name: item.track.name,
            artist: (item.track.artists || []).map(a => a.name).join(', '),
            album: { image: item.track.album?.images?.[0]?.url || null }
        }));

        res.json({
            ok: true,
            playlist: {
                id: playlistDbId,
                name: playlist.name,
                canEdit: true
            },
            tracks: simplified
        });
    } catch (err) {
        console.error('[custom-playlists:tracks]', err);
        res.status(500).json({ ok: false, error: 'Failed to load tracks' });
    }
});

// POST /api/custom-playlists/add-song — add a song to a custom playlist (100 digipogs)
router.post('/api/custom-playlists/add-song', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const userIsOwner = isOwner(userId);

    if (!userIsOwner) {
        if (!req.session.hasPaid) {
            return res.status(402).json({ ok: false, error: 'Payment required to add a song' });
        }
        if (req.session?.payment?.pendingAction !== 'addPlaylistSong') {
            return res.status(409).json({ ok: false, error: 'Payment is not linked to adding a song' });
        }
        const paidPlaylistId = req.session?.payment?.playlistId;
        const { playlistId } = req.body || {};
        if (paidPlaylistId && String(paidPlaylistId) !== String(playlistId)) {
            return res.status(409).json({ ok: false, error: 'Payment is not linked to this playlist' });
        }
    }

    const userBanned = await getUserBanned(userId).catch(() => false);
    if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

    const { playlistId, trackUri } = req.body || {};
    const playlistDbId = parseInt(playlistId);

    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });
    if (!isValidTrackUri(trackUri)) return res.status(400).json({ ok: false, error: 'Invalid track URI' });

    try {
        const classId = await getClassId();
        const playlist = await getCustomPlaylistForClass(playlistDbId, classId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        const trackValidation = await validateTrackUris([trackUri]);
        if (!trackValidation.valid) {
            return res.status(400).json({ ok: false, error: trackValidation.error });
        }

        await ensureSpotifyAccessToken();
        const accessToken = spotifyApi.getAccessToken();
        const addRes = await fetch(`https://api.spotify.com/v1/playlists/${playlist.spotify_playlist_id}/tracks`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: [trackUri] })
        });
        if (!addRes.ok) throw new Error(`addTracks failed: ${addRes.status}`);

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE custom_playlists SET song_count = song_count + 1 WHERE id = ?',
                [playlistDbId],
                err => err ? reject(err) : resolve()
            );
        });

        if (!userIsOwner) {
            req.session.hasPaid = false;
            req.session.payment = null;
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'addPlaylistSong',
            trackURI: trackUri,
            trackName: playlist.name,
            artistName: 'Custom Playlist',
            cost: userIsOwner ? 0 : ADD_PLAYLIST_SONG_AMOUNT()
        }).catch(err => console.error('[custom-playlists:add-song] log failed:', err));

        req.session.save(() => {
            res.json({ ok: true, message: 'Song added to playlist' });
        });
    } catch (err) {
        console.error('[custom-playlists:add-song]', err);
        res.status(500).json({ ok: false, error: 'Failed to add song to playlist' });
    }
});

// POST /api/custom-playlists/remove-song — remove a song from a custom playlist (50 digipogs).
router.post('/api/custom-playlists/remove-song', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const userIsOwner = isOwner(userId);

    if (!userIsOwner) {
        if (!req.session.hasPaid) {
            return res.status(402).json({ ok: false, error: 'Payment required to remove a song' });
        }
        if (req.session?.payment?.pendingAction !== 'removePlaylistSong') {
            return res.status(409).json({ ok: false, error: 'Payment is not linked to removing a song' });
        }
        const paidPlaylistId = req.session?.payment?.playlistId;
        const { playlistId } = req.body || {};
        if (paidPlaylistId && String(paidPlaylistId) !== String(playlistId)) {
            return res.status(409).json({ ok: false, error: 'Payment is not linked to this playlist' });
        }
    }

    const userBanned = await getUserBanned(userId).catch(() => false);
    if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

    const { playlistId, trackUri } = req.body || {};
    const playlistDbId = parseInt(playlistId);

    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });
    if (!isValidTrackUri(trackUri)) return res.status(400).json({ ok: false, error: 'Invalid track URI' });

    try {
        const classId = await getClassId();
        const playlist = await getCustomPlaylistForClass(playlistDbId, classId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        await ensureSpotifyAccessToken();
        const removeToken = spotifyApi.getAccessToken();
        const removeRes = await fetch(`https://api.spotify.com/v1/playlists/${playlist.spotify_playlist_id}/tracks`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${removeToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: [{ uri: trackUri }] })
        });
        if (!removeRes.ok) throw new Error(`removeTracks failed: ${removeRes.status}`);

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE custom_playlists SET song_count = MAX(0, song_count - 1) WHERE id = ?',
                [playlistDbId],
                err => err ? reject(err) : resolve()
            );
        });

        if (!userIsOwner) {
            req.session.hasPaid = false;
            req.session.payment = null;
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'removePlaylistSong',
            trackURI: trackUri,
            trackName: playlist.name,
            artistName: 'Custom Playlist',
            cost: userIsOwner ? 0 : REMOVE_PLAYLIST_SONG_AMOUNT()
        }).catch(err => console.error('[custom-playlists:remove-song] log failed:', err));

        req.session.save(() => {
            res.json({ ok: true, message: 'Song removed from playlist' });
        });
    } catch (err) {
        console.error('[custom-playlists:remove-song]', err);
        res.status(500).json({ ok: false, error: 'Failed to remove song from playlist' });
    }
});

// POST /api/custom-playlists/queue — start playback from one of the caller's custom playlists
router.post('/api/custom-playlists/queue', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const userIsOwner = isOwner(userId);

    const { playlistId } = req.body || {};
    const playlistDbId = parseInt(playlistId);
    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });

    try {
        if (!userIsOwner) {
            if (!req.session.hasPaid) {
                return res.status(402).json({ ok: false, error: 'Payment required to play this playlist' });
            }
            if (req.session?.payment?.pendingAction !== 'customPlaylistPlay') {
                return res.status(409).json({ ok: false, error: 'Payment is not linked to custom playlist playback' });
            }
            const paidPlaylistId = req.session?.payment?.playlistId;
            if (paidPlaylistId && String(paidPlaylistId) !== String(playlistId)) {
                return res.status(409).json({ ok: false, error: 'Payment is not linked to this playlist' });
            }
            const paidAmount = Number(req.session?.payment?.amount) || 0;
            if (paidAmount < CUSTOM_PLAYLIST_PLAY_AMOUNT()) {
                return res.status(409).json({ ok: false, error: 'Insufficient payment for playlist playback' });
            }
        }

        const classId = await getClassId();
        const playlist = await getCustomPlaylistForClass(playlistDbId, classId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        const userBanned = await getUserBanned(userId).catch(() => false);
        if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

        await ensureSpotifyAccessToken();
        const playlistUri = `spotify:playlist:${playlist.spotify_playlist_id}`;
        await spotifyApi.play({ context_uri: playlistUri });
        try {
            await spotifyApi.setShuffle(true);
        } catch (shuffleErr) {
            console.warn('[custom-playlists:queue] could not enable shuffle:', shuffleErr.message);
        }

        try {
            await queueManager.syncWithSpotify(spotifyApi);
        } catch (syncErr) {
            console.warn('[custom-playlists:queue] queue sync failed:', syncErr.message);
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'playlist',
            trackURI: playlistUri,
            trackName: playlist.name,
            artistName: 'Custom Playlist',
            cost: userIsOwner ? 0 : CUSTOM_PLAYLIST_PLAY_AMOUNT()
        }).catch(err => console.error('[custom-playlists:queue] log failed:', err));

        if (!userIsOwner) {
            req.session.hasPaid = false;
            req.session.payment = null;
            return req.session.save(() => {
                res.json({ ok: true, message: `Started playlist playback (${playlist.name})` });
            });
        }

        return res.json({ ok: true, message: `Started playlist playback (${playlist.name})` });
    } catch (err) {
        console.error('[custom-playlists:queue]', err);
        res.status(500).json({ ok: false, error: 'Failed to play playlist' });
    }
});

module.exports = router;
