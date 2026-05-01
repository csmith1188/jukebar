const express = require('express');
const router = express.Router();
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const db = require('../utils/database');
const { logTransaction } = require('./logging');
const queueManager = require('../utils/queueManager');
const { isAuthenticated } = require('../middleware/auth');
const { isOwner, getFirstOwnerId } = require('../utils/owners');
const { refund: poolRefund } = require('../utils/transferManager');
const { getCurrentClassId, requestAndWaitForClassId } = require('./socket');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    READ,
    MODIFY,
    playbackRateLimit,
    executePlaybackRead,
    executePlaybackModify,
    setSpotifyPlaybackCooldown
} = require('../middleware/spotifyPlaybackRateLimit');

// Play random sound from /sfx folder
let isPlayingSound = false;

const APRIL_FOOLS_URI = 'spotify:track:0rQvvjAkX1B0gcJwjEGQZW';
const APRIL_FOOLS_CHANCE = 0.3; // 30% chance
const SEARCH_CACHE_TTL_MS = 12_000;
/** Minimum time between POST /search calls per user (stricter = fewer Spotify search API hits). */
const SEARCH_MIN_INTERVAL_MS = 2500;
/** Rolling cap: max search requests per user within the window (in addition to min interval). */
const SEARCH_BURST_WINDOW_MS = 60 * 1000;
const SEARCH_MAX_PER_WINDOW = 8;
const SEARCH_CACHE_MAX_ITEMS = 500;
const searchResponseCache = new Map();
const searchRequesterLastAt = new Map();
const searchRequesterBurstTimestamps = new Map();
let spotifySearchRateLimitedUntil = 0;

function isAprilFools() {
    const now = new Date();
    return now.getMonth() === 3 && now.getDate() === 1; // month is 0-indexed
}

function shouldAprilFool() {
    return isAprilFools() && Math.random() < APRIL_FOOLS_CHANCE;
}

function getSearchRequesterKey(req) {
    return String(req.session?.token?.id || req.ip || 'anonymous');
}

function pruneSearchBurstTimestamps(requesterKey, now) {
    const cutoff = now - SEARCH_BURST_WINDOW_MS;
    let ts = searchRequesterBurstTimestamps.get(requesterKey);
    if (!ts) {
        ts = [];
    } else {
        ts = ts.filter((t) => t > cutoff);
    }
    searchRequesterBurstTimestamps.set(requesterKey, ts);
    return ts;
}

/** @returns {{ ok: true } | { ok: false, retryAfterMs: number }} */
function tryConsumeSearchBurstSlot(requesterKey, now) {
    const ts = pruneSearchBurstTimestamps(requesterKey, now);
    if (ts.length >= SEARCH_MAX_PER_WINDOW) {
        const oldest = ts[0];
        return { ok: false, retryAfterMs: Math.max(1, SEARCH_BURST_WINDOW_MS - (now - oldest)) };
    }
    ts.push(now);
    searchRequesterBurstTimestamps.set(requesterKey, ts);
    return { ok: true };
}

function sendSearchClientRateLimit(res, message, retryAfterMs) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
        ok: false,
        error: message,
        retryAfterSeconds: retryAfterSec
    });
}

function pruneSearchCache(now) {
    if (searchResponseCache.size > SEARCH_CACHE_MAX_ITEMS) {
        const entries = [...searchResponseCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        const removeCount = Math.ceil(entries.length * 0.2);
        for (let i = 0; i < removeCount; i++) {
            searchResponseCache.delete(entries[i][0]);
        }
    }

    for (const [key, value] of searchResponseCache.entries()) {
        if ((now - value.timestamp) > SEARCH_CACHE_TTL_MS) {
            searchResponseCache.delete(key);
        }
    }
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

/** Spotify /v1/search — limit must be 1–10; higher values return 400 Invalid limit. */
const SPOTIFY_SEARCH_LIMIT_MAX = 10;

// Store currently playing track info (legacy - use queueManager instead)
let currentTrack = null;

// Helper function to handle Spotify API errors consistently
function handleSpotifyError(error, res, action = 'operation') {
    // spotify-web-api-node WebapiError sets error.message = String(body) when the body object
    // is passed directly to Error(), producing the sentinel "[object Object]".
    // Fall through it and extract from error.body instead.
    const rawMsg = error?.message;
    let errMsg;
    if (typeof rawMsg === 'string' && rawMsg && rawMsg !== '[object Object]') {
        errMsg = rawMsg;
    } else {
        const bodyMsg = error?.body?.error?.message;
        if (typeof bodyMsg === 'string' && bodyMsg) {
            errMsg = bodyMsg;
        } else if (error?.body && typeof error.body === 'object') {
            try { errMsg = JSON.stringify(error.body); } catch { errMsg = String(error); }
        } else {
            errMsg = String(error);
        }
    }
    console.error(`Spotify ${action} error [${error?.statusCode ?? 'unknown'}]: ${errMsg}`);

    const spotifyStatus = Number(error?.statusCode) || 500;
    const spotifyBody = error?.body || null;
    const spotifyMessage =
        (typeof error?.body?.error?.message === 'string' && error.body.error.message) ||
        (typeof rawMsg === 'string' && rawMsg && rawMsg !== '[object Object]' ? rawMsg : null) ||
        errMsg;

    // Handle network connectivity errors
    if (error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return res.status(503).json({
            ok: false,
            error: 'Unable to connect to Spotify. Please check your internet connection and try again.',
            spotifyStatus,
            spotifyError: spotifyMessage
        });
    }

    // Handle authentication errors
    if (error.statusCode === 401) {
        return res.status(401).json({
            ok: false,
            error: spotifyMessage || 'Spotify authentication failed',
            spotifyStatus,
            spotifyBody
        });
    }

    // Handle rate limiting
    if (error.statusCode === 429) {
        return res.status(429).json({
            ok: false,
            error: spotifyMessage || 'Too many requests to Spotify. Please wait a moment and try again.',
            spotifyStatus,
            spotifyBody
        });
    }

    // Handle 404 errors (no active device)
    if (error.statusCode === 404) {
        return res.status(400).json({
            ok: false,
            error: spotifyMessage || 'No active Spotify playback found. Please start playing music on a Spotify device first.',
            spotifyStatus,
            spotifyBody
        });
    }

    // Generic error
    return res.status(spotifyStatus).json({
        ok: false,
        error: spotifyMessage || `Failed to ${action}`,
        spotifyStatus,
        spotifyBody
    });
}

function formatSpotifyErrorForLog(error) {
    const status = error?.statusCode ?? 'unknown';
    const message =
        error?.body?.error?.message ||
        (typeof error?.message === 'string' && error.message !== '[object Object]' ? error.message : null) ||
        'Unknown Spotify error';
    let body = '';
    if (error?.body && typeof error.body === 'object') {
        try { body = ` body=${JSON.stringify(error.body)}`; } catch { body = ''; }
    }
    return `[${status}] ${message}${body}`;
}

/**
 * Resolves the current class ID. Uses cached value if available,
 * otherwise asks Formbar for it via socket. Returns null if unavailable —
 * callers treat null as "default/no class" which still works with the DB.
 */
async function getClassId() {
    const cached = getCurrentClassId();
    if (cached !== null && cached !== undefined) return cached;
    const fetched = await requestAndWaitForClassId();
    return fetched ?? null;
}

// SQLite helper: NULL-safe class_id comparison.
// "class_id = ?" fails when ? is NULL because NULL = NULL → false.
// This uses "class_id IS ?" which handles NULL correctly.
const CLASS_ID_WHERE = 'class_id IS ?';

function getAllowedPlaylist(playlistId, classId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT spotify_playlist_id, name, owner_name, image_url, total_tracks, is_allowed
             FROM allowed_playlists
             WHERE spotify_playlist_id = ? AND ${CLASS_ID_WHERE}`,
            [playlistId, classId],
            (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            }
        );
    });
}

// Fetches all allowed playlists for the given class ID, sorted by name
function getAllowedPlaylists(classId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT spotify_playlist_id, name, owner_name, image_url, total_tracks
             FROM allowed_playlists
             WHERE is_allowed = 1 AND ${CLASS_ID_WHERE}
             GROUP BY spotify_playlist_id
             ORDER BY lower(name) ASC`,
            [classId],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            }
        );
    });
}

// Fetches a map of playlist ID 
function getAllowedPlaylistMap(classId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT spotify_playlist_id, MAX(is_allowed) as is_allowed
             FROM allowed_playlists
             WHERE ${CLASS_ID_WHERE}
             GROUP BY spotify_playlist_id`,
            [classId], (err, rows) => {
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
        // Use LIMIT 1 since UNIQUE constraint doesn't prevent NULL duplicates
        db.get(
            `SELECT id FROM allowed_playlists WHERE spotify_playlist_id = ? AND ${CLASS_ID_WHERE} LIMIT 1`,
            [playlist.id, classId],
            (err, row) => {
                if (err) return reject(err);
                if (row) {
                    db.run(
                        `UPDATE allowed_playlists
                         SET name = ?, owner_name = ?, image_url = ?, total_tracks = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [
                            playlist.name || 'Untitled Playlist',
                            playlist.owner || 'Unknown',
                            playlist.image || null,
                            Number(playlist.totalTracks) || 0,
                            updatedBy || null,
                            row.id
                        ],
                        (err) => {
                            if (err) return reject(err);
                            resolve();
                        }
                    );
                } else {
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
        // Update only the first matching row (handles NULL class_id duplicates)
        db.get(
            `SELECT id FROM allowed_playlists WHERE spotify_playlist_id = ? AND ${CLASS_ID_WHERE} LIMIT 1`,
            [playlistId, classId],
            (err, row) => {
                if (err) return reject(err);
                if (!row) return resolve(0);
                db.run(
                    `UPDATE allowed_playlists
                     SET is_allowed = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [isAllowed ? 1 : 0, teacherId || null, row.id],
                    function (err) {
                        if (err) return reject(err);
                        resolve(this.changes || 0);
                    }
                );
            }
        );
    });
}

// Fetches all tracks from a playlist, returns array of tracks
async function fetchAllUserPlaylists() {
    const allItems = [];
    const limit = 50;
    let offset = 0;

    while (true) {
        const playlistData = await spotifyApi.getUserPlaylists({ limit, offset });
        const items = playlistData.body?.items || [];
        allItems.push(...items);
        if (items.length < limit) break;
        offset += limit;
    }

    return allItems;
}

// Deletes allowed playlists for the class that are not in the provided playlistIds array
function pruneAllowedPlaylistsNotInLibrary(classId, playlistIds) {
    return new Promise((resolve, reject) => {
        const uniqueIds = [...new Set((playlistIds || []).filter(Boolean))];

        if (uniqueIds.length === 0) {
            return db.run(
                `DELETE FROM allowed_playlists WHERE ${CLASS_ID_WHERE}`,
                [classId],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes || 0);
                }
            );
        }

        const placeholders = uniqueIds.map(() => '?').join(',');
        db.run(
            `DELETE FROM allowed_playlists
             WHERE ${CLASS_ID_WHERE}
               AND spotify_playlist_id NOT IN (${placeholders})`,
            [classId, ...uniqueIds],
            function (err) {
                if (err) return reject(err);
                resolve(this.changes || 0);
            }
        );
    });
}

// Fetches all tracks from a playlist, returns array of track items 
async function fetchPlaylistTracks(playlistId) {
    await ensureSpotifyAccessToken();
    const tracks = [];
    let offset = 0;
    const limit = 100;
    let fetchError = null;

    while (true) {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` }
        });

        if (!res.ok) {
            const body = await res.text();
            console.error(`[fetchPlaylistTracks] Spotify returned ${res.status} at offset=${offset}: ${body}`);
            if (res.status === 403) {
                fetchError = { status: 403, message: 'Spotify denied access to this playlist. The connected Spotify account must own or collaborate on the playlist (Feb 2026 API change).' };
            } else if (res.status === 429) {
                const retryAfter = res.headers.get('retry-after');
                console.warn(`[fetchPlaylistTracks] Rate limited. Retry-After: ${retryAfter}s`);
                fetchError = { status: 429, message: `Rate limited by Spotify. Try again in ${retryAfter || 'a few'} seconds.` };
            } else {
                fetchError = { status: res.status, message: `Spotify returned HTTP ${res.status} when fetching playlist tracks.` };
            }
            break;
        }

        const data = await res.json();
        const items = data?.items || [];
        console.log(`[fetchPlaylistTracks] offset=${offset} fetched=${items.length} total=${data?.total ?? '?'}`);
        tracks.push(...items);
        if (items.length < limit || (data?.total && tracks.length >= data.total)) break;
        offset += limit;
    }

    return { tracks, error: fetchError };
}

function computePlaylistCost(trackCount) {
    const songAmount = Number(process.env.SONG_AMOUNT) || 50;
    return Math.min(Math.round(songAmount * Math.sqrt(trackCount)), 500);
}

function isTrackBanned(t, bannedPairs) {
    const name = (t.name || '').trim().toLowerCase();
    const artist = (t.artists || []).map(a => a.name).join(', ').trim().toLowerCase();
    return bannedPairs.has(`${name}::${artist}`);
}

async function getQueueUriSet() {
    const queueUris = new Set((queueManager.queue || []).map((track) => track?.uri).filter(Boolean));
    const currentUri = queueManager.currentTrack?.uri;
    if (currentUri) queueUris.add(currentUri);
    return queueUris;
}

async function getQueueablePlaylistTracks(playlistId) {
    const [fetchResult, bannedSongs, queueUris] = await Promise.all([
        fetchPlaylistTracks(playlistId),
        getBannedSongs(),
        getQueueUriSet()
    ]);
    const rawItems = fetchResult.tracks;

    const bannedPairs = new Set(
        (bannedSongs || []).map((row) => `${(row.track_name || '').trim().toLowerCase()}::${(row.artist_name || '').trim().toLowerCase()}`)
    );

    const queueableTracks = [];
    const skipped = { unplayable: 0, banned: 0, duplicate: 0 };

    // Feb 2026 Spotify API changes renamed .track to .item, so check both places for track data
    for (const item of rawItems) {
        const track = item?.item ?? item?.track; // .track renamed to .item in Feb 2026 Spotify API changes
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

// Fetches all tracks from a playlist, returns count of playable tracks and skipped tracks breakdown
async function getPlaylistPlayableStats(playlistId) {
    const { tracks: rawItems, error: fetchError } = await fetchPlaylistTracks(playlistId);

    if (fetchError) {
        console.error(`[getPlaylistPlayableStats] fetch failed for ${playlistId}: ${fetchError.message}`);
        return { playableCount: 0, fetchError, skipped: { unplayable: 0, banned: 0, duplicate: 0 } };
    }

    let playableCount = 0;
    let unplayableCount = 0;

    for (const item of rawItems) {
        const track = item?.item ?? item?.track;
        if (!track || track.is_local || !track.uri || !track.uri.startsWith('spotify:track:')) {
            unplayableCount += 1;
            continue;
        }
        playableCount += 1;
    }

    console.log(`[getPlaylistPlayableStats] playlistId=${playlistId} rawItems=${rawItems.length} playable=${playableCount} unplayable=${unplayableCount}`);

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
    const playback = await executePlaybackRead({ session: null, ip: 'server-helper' }, 'helper-currentTrackUri', () => spotifyApi.getMyCurrentPlayingTrack());
    return playback?.body?.item?.uri || null;
}

// Checks if any track from the playlist is currently playing
async function isPlaylistCurrentlyPlaying(playlistId, preloadedItems = null) {
    const currentTrackUri = await getCurrentTrackUri();
    if (!currentTrackUri) return false;

    const playlistItems =
        preloadedItems != null
            ? preloadedItems
            : (await fetchPlaylistTracks(playlistId)).tracks;
    return playlistItems.some((item) => (item?.item ?? item?.track)?.uri === currentTrackUri);
}

// Socket.IO setup to communicate with Formbar for classroom management
router.post('/search', async (req, res) => {
    try {
        let { query, source, offset, limit, desiredTotal, includeArtists, includeAlbums } = req.body || {};
        if (!query || !query.trim()) {
            return res.status(400).json({ ok: false, error: 'Missing query' });
        }
        query = query.trim();
        if (query.length < 2) {
            return res.status(400).json({ ok: false, error: 'Search query must be at least 2 characters' });
        }

        const now = Date.now();
        pruneSearchCache(now);
        if (now < spotifySearchRateLimitedUntil) {
            const retryAfterSeconds = Math.max(1, Math.ceil((spotifySearchRateLimitedUntil - now) / 1000));
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                ok: false,
                error: 'Spotify search is temporarily cooling down due to rate limits. Try again in a moment.',
                retryAfterSeconds
            });
        }

        const DEFAULT_SEARCH_LIMIT = 5;
        const MAX_SEARCH_LIMIT = SPOTIFY_SEARCH_LIMIT_MAX;
        const DEFAULT_DESIRED_TOTAL = 10;
        const MAX_DESIRED_TOTAL = 20;
        const MAX_SEARCH_PAGES = 1;
        const MAX_SEARCH_OFFSET = 1000;

        const parsedLimit = Number.parseInt(limit, 10);
        const SEARCH_LIMIT = Number.isInteger(parsedLimit)
            ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, parsedLimit))
            : DEFAULT_SEARCH_LIMIT;

        const parsedDesiredTotal = Number.parseInt(desiredTotal, 10);
        const DESIRED_TOTAL = Number.isInteger(parsedDesiredTotal)
            ? Math.min(MAX_DESIRED_TOTAL, Math.max(1, parsedDesiredTotal))
            : DEFAULT_DESIRED_TOTAL;

        const parsedOffset = Number.parseInt(offset, 10);
        offset = Number.isFinite(parsedOffset)
            ? Math.min(MAX_SEARCH_OFFSET, Math.max(0, parsedOffset))
            : 0;

        const requesterKey = getSearchRequesterKey(req);
        const lastRequestAt = searchRequesterLastAt.get(requesterKey) || 0;
        if ((now - lastRequestAt) < SEARCH_MIN_INTERVAL_MS) {
            return sendSearchClientRateLimit(
                res,
                'You are searching too quickly. Please wait a moment before searching again.',
                SEARCH_MIN_INTERVAL_MS - (now - lastRequestAt)
            );
        }

        const burst = tryConsumeSearchBurstSlot(requesterKey, now);
        if (!burst.ok) {
            return sendSearchClientRateLimit(
                res,
                'Too many searches in a short period. Please wait before searching again.',
                burst.retryAfterMs
            );
        }

        searchRequesterLastAt.set(requesterKey, now);

        const cacheKey = JSON.stringify({
            query: query.toLowerCase(),
            source: source || '',
            offset,
            SEARCH_LIMIT,
            DESIRED_TOTAL,
            includeArtists: !!includeArtists,
            includeAlbums: !!includeAlbums
        });
        const cached = searchResponseCache.get(cacheKey);
        if (cached && (now - cached.timestamp) <= SEARCH_CACHE_TTL_MS) {
            return res.json(cached.payload);
        }
        
        // Debug logging for pagination and limit issues
        // console.log('[/search] Request params:', {
        //     query: query.trim(),
        //     limit: SEARCH_LIMIT,
        //     offset,
        //     desiredTotal: DESIRED_TOTAL,
        //     limitType: typeof SEARCH_LIMIT,
        //     offsetType: typeof offset
        // });
        
        await ensureSpotifyAccessToken();

        // Start artist and album searches in parallel for first-page requests
        const artistSearchPromise = (includeArtists && offset === 0 && query.length >= 3)
            ? spotifyApi.search(query, ['artist'], { limit: 5 }).catch(() => null)
            : Promise.resolve(null);

        const albumSearchPromise = (includeAlbums && offset === 0 && query.length >= 3)
            ? spotifyApi.search(query, ['album'], { limit: 8 }).catch(() => null)
            : Promise.resolve(null);

        let total = 0;
        let currentOffset = offset;
        let pagesFetched = 0;
        const aggregatedItems = [];
        let rateLimited = false;

        while (aggregatedItems.length < DESIRED_TOTAL && pagesFetched < MAX_SEARCH_PAGES) {
            let searchData;
            try {
                searchData = await spotifyApi.searchTracks(query, { limit: SEARCH_LIMIT, offset: currentOffset });
            } catch (pageErr) {
                if (pageErr.statusCode === 429) {
                    // Rate limited — return whatever we've collected so far
                    rateLimited = true;
                    const retryAfterHeader =
                        pageErr?.headers?.['retry-after'] ||
                        pageErr?.response?.headers?.['retry-after'] ||
                        pageErr?.response?.headers?.get?.('retry-after');
                    const retryAfterSeconds = Number.parseInt(String(retryAfterHeader || ''), 10);
                    const cooldownMs = (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 10000);
                    spotifySearchRateLimitedUntil = Date.now() + cooldownMs;
                    break;
                }
                throw pageErr;
            }
            const tracks = searchData.body?.tracks;
            const items = tracks?.items || [];
            total = tracks?.total || total;

            aggregatedItems.push(...items);
            pagesFetched += 1;

            if (items.length < SEARCH_LIMIT) break;

            const next = currentOffset + SEARCH_LIMIT;
            if (next > MAX_SEARCH_OFFSET) break;
            if (total && next >= total) break;
            currentOffset = next;
        }

        // console.log('[/search] Search aggregation:', { pagesFetched, fetchedItems: aggregatedItems.length, total });

        if (rateLimited && aggregatedItems.length === 0) {
            const retryAfterSeconds = Math.max(1, Math.ceil((spotifySearchRateLimitedUntil - Date.now()) / 1000));
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                ok: false,
                error: 'Spotify is rate limiting search requests right now. Please wait a few seconds and try again.',
                retryAfterSeconds
            });
        }

        const items = aggregatedItems.slice(0, DESIRED_TOTAL);

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
        // Resolve artist search for first-page results
        let artists = [];
        if (includeArtists && offset === 0) {
            const artistData = await artistSearchPromise;
            const artistItems = artistData?.body?.artists?.items || [];
            artists = artistItems.map(a => ({
                id: a.id,
                name: a.name,
                image: a.images?.[0]?.url || null,
                genres: (a.genres || []).slice(0, 3),
                popularity: a.popularity || 0
            }));
        }

        // Resolve album search for first-page results
        let albums = [];
        if (includeAlbums && offset === 0) {
            const albumData = await albumSearchPromise;
            const albumItems = albumData?.body?.albums?.items || [];
            albums = albumItems.map(a => ({
                id: a.id,
                name: a.name,
                image: a.images?.[0]?.url || null,
                artists: (a.artists || []).map(art => art.name).join(', '),
                release_date: a.release_date || '',
                total_tracks: a.total_tracks || 0,
                album_type: a.album_type || 'album'
            }));
        }

        const nextOffset = Math.min(offset + (pagesFetched * SEARCH_LIMIT), MAX_SEARCH_OFFSET);
        const payload = {
            ok: true,
            tracks: { items: simplified },
            artists,
            albums,
            nextOffset,
            hasMore: nextOffset < total
        };
        searchResponseCache.set(cacheKey, { timestamp: Date.now(), payload });
        return res.json(payload);
    } catch (err) {
        if (err?.statusCode === 429) {
            const retryAfterHeader =
                err?.headers?.['retry-after'] ||
                err?.response?.headers?.['retry-after'] ||
                err?.response?.headers?.get?.('retry-after');
            const retryAfterSeconds = Number.parseInt(String(retryAfterHeader || ''), 10);
            const cooldownMs = (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 10000);
            spotifySearchRateLimitedUntil = Date.now() + cooldownMs;
        }
        return handleSpotifyError(err, res, 'search');
    }
});

// Returns the user's recently queued songs based on their transaction history, excluding cleared history
router.get('/recentlyQueued', async (req, res) => {
    if (!req.session?.token?.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT t.track_uri, t.track_name, t.artist_name, t.image_url, t.action FROM transactions t
                 LEFT JOIN users u ON u.id = t.user_id
                 WHERE t.user_id = ? AND t.action IN ('play', 'artist_click', 'album_click')
                   AND (u.recently_queued_cleared_at IS NULL OR t.timestamp > u.recently_queued_cleared_at)
                 ORDER BY t.timestamp DESC LIMIT 200`,
                [req.session.token.id],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });

        // Deduplicate: keep only the most recent item of each URI, cap at 50
        const seen = new Set();
        const uniqueRows = rows.filter(r => {
            if (seen.has(r.track_uri)) return false;
            seen.add(r.track_uri);
            return true;
        }).slice(0, 50);

        if (uniqueRows.length === 0) {
            return res.json({ ok: true, tracks: [] });
        }

        // Map transactions to track objects, inferring type and handling missing data
        const tracks = uniqueRows.map((r) => {
            const itemType = r.action === 'artist_click' ? 'artist' : (r.action === 'album_click' ? 'album' : 'track');
            const fallbackSubtitle = itemType === 'track' ? 'Unknown' : '';
            const subtitleText = (r.artist_name || fallbackSubtitle);
            const yearMatch = itemType === 'album' ? String(subtitleText).match(/\b(19|20)\d{2}\b/) : null;
            return {
                name: r.track_name || 'Unknown',
                artist: subtitleText,
                uri: r.track_uri,
                album: { name: '', image: r.image_url || '' },
                itemType,
                releaseYear: yearMatch ? yearMatch[0] : ''
            };
        });

        return res.json({ ok: true, tracks });
    } catch (err) {
        console.error('Error fetching recently queued:', err);
        return res.status(500).json({ ok: false, error: 'Failed to fetch recently queued songs' });
    }
});

// Logs interactions with recently queued items 
router.post('/recentlyQueued/interactions', isAuthenticated, async (req, res) => {
    const userId = req.session?.token?.id;
    if (!userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { type, id, name, subtitle, image } = req.body || {};
    const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
    const safeId = typeof id === 'string' ? id.trim() : '';
    const safeName = typeof name === 'string' ? name.trim() : '';

    if (!['artist', 'album'].includes(normalizedType)) {
        return res.status(400).json({ ok: false, error: 'Invalid interaction type' });
    }
    if (!safeId || !safeName) {
        return res.status(400).json({ ok: false, error: 'Missing interaction metadata' });
    }

    const action = normalizedType === 'artist' ? 'artist_click' : 'album_click';
    const uri = `spotify:${normalizedType}:${safeId}`;
    const safeSubtitle = typeof subtitle === 'string' ? subtitle.trim() : '';
    const safeImage = typeof image === 'string' ? image.trim() : '';

    try {
        await logTransaction({
            userID: userId,
            displayName: req.session.user,
            action,
            trackURI: uri,
            trackName: safeName.slice(0, 200),
            artistName: safeSubtitle.slice(0, 200),
            imageURL: safeImage || null,
            cost: 0
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('Failed to log recently queued interaction:', error);
        res.status(500).json({ ok: false, error: 'Failed to save interaction' });
    }
});

// Clear the user's recently queued history by setting to now
router.post('/clearQueueHistory', async (req, res) => {
    if (!req.session?.token?.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE users SET recently_queued_cleared_at = datetime('now') WHERE id = ?`,
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

// Teacher-only: clear recently queued for ALL users (transactions stay intact)
router.post('/clearAllRecentlyQueued', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE users SET recently_queued_cleared_at = datetime('now')`,
                (err) => err ? reject(err) : resolve()
            );
        });

        const io = req.app.get('io');
        if (io) io.emit('recentlyQueuedCleared');

        return res.json({ ok: true, message: 'Recently queued cleared for all users' });
    } catch (err) {
        console.error('Error clearing all recently queued:', err);
        return res.status(500).json({ ok: false, error: 'Failed to clear recently queued' });
    }
});

// Fetches the user's Spotify playlists, merges with allowed playlists from DB, and returns the combined data
router.get('/api/spotify/playlists', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const classId = await getClassId();

        const [items, meData] = await Promise.all([
            fetchAllUserPlaylists(),
            spotifyApi.getMe().catch(() => null)
        ]);
        const myId = meData?.body?.id;

        const removedCount = await pruneAllowedPlaylistsNotInLibrary(
            classId,
            items.map((playlist) => playlist?.id)
        );
        if (removedCount > 0) {
            console.log(`[playlist:sync] Removed ${removedCount} stale allowed playlist row(s) for classId=${classId}`);
        }

        const allowedMap = await getAllowedPlaylistMap(classId);

        const playlists = items.map((playlist) => {
            const ownerId = playlist.owner?.id;
            const collaborative = !!playlist.collaborative;
            const formatted = {
            id: playlist.id,
            name: playlist.name || 'Untitled Playlist',
            totalTracks: playlist.items?.total ?? playlist.tracks?.total ?? 0,
            image: playlist.images?.[0]?.url || null,
            owner: playlist.owner?.display_name || ownerId || 'Unknown',
            url: playlist.external_urls?.spotify || null,
            uri: playlist.uri,
            isAllowed: allowedMap.get(playlist.id) || false,
            canAccessTracks: (myId && ownerId === myId) || collaborative
            };
            return formatted;
        });

        await Promise.all(playlists.map((playlist) => upsertPlaylistMetadata(playlist, req.session?.token?.id, classId)));

        return res.json({ ok: true, playlists });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch playlists');
    }
});

// Teacher only: allow a playlist by ID, inserting/updating metadata and setting allowed state to true
router.post('/api/spotify/playlists/allow', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { playlistId, name, owner, image, totalTracks } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = await getClassId();
        const teacherId = req.session?.token?.id;

        await upsertPlaylistMetadata({
            id: playlistId,
            name,
            owner,
            image,
            totalTracks
        }, teacherId, classId);

        const changes = await setPlaylistAllowedState(playlistId, true, teacherId, classId);
        if (!changes) {
            console.warn(`[playlist:allow] 0 rows updated — playlistId=${playlistId} classId=${classId}`);
        }

        return res.json({ ok: true, message: 'Playlist allowed' });
    } catch (err) {
        console.error('[playlist:allow]', err);
        return res.status(500).json({ ok: false, error: 'Failed to allow playlist' });
    }
});

// Teacher only: disallow a playlist by ID, setting allowed state to false 
router.post('/api/spotify/playlists/disallow', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = await getClassId();
        const teacherId = req.session?.token?.id;
        console.log(`[playlist:disallow] teacher=${teacherId} playlistId=${playlistId} classId=${classId}`);

        const changes = await setPlaylistAllowedState(playlistId, false, teacherId, classId);
        console.log(`[playlist:disallow] setAllowedState result: ${changes} row(s) updated`);
        if (!changes) {
            return res.status(404).json({ ok: false, error: 'Playlist not found' });
        }

        return res.json({ ok: true, message: 'Playlist disallowed' });
    } catch (err) {
        console.error('[playlist:disallow] error:', err);
        return res.status(500).json({ ok: false, error: 'Failed to disallow playlist' });
    }
});

// Teacher only: fetch all allowed playlists for the class, returning metadata and allowed state
router.get('/api/playlists/allowed', isAuthenticated, async (req, res) => {
    try {
        const classId = await getClassId();
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

// Builds a quote for a playlist by counting playable tracks and creating a preview of the first 200 tracks with metadata and playability info
function buildPlaylistQuoteFromItems(rawItems) {
    let playableCount = 0;
    const preview = [];
    const PREVIEW_MAX = 200;

    for (const item of rawItems) {
        const track = item?.item ?? item?.track;
        const playable = !!(track && !track.is_local && track.uri && track.uri.startsWith('spotify:track:'));
        if (playable) {
            playableCount += 1;
        }

        if (preview.length < PREVIEW_MAX) {
            if (!track) {
                preview.push({ name: 'Unknown item', artist: '', image: null, playable: false });
            } else {
                const name = (track.name || 'Unknown track').trim();
                const artist = (track.artists || []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown artist';
                const image = track.album?.images?.[0]?.url || null;
                preview.push({ name, artist, image, playable });
            }
        }
    }

    return {
        playableCount,
        preview,
        totalItems: rawItems.length,
        previewCapped: rawItems.length > preview.length
    };
}

// Endpoint to quote a playlist: checks if playlist is allowed, counts playable tracks, checks if it's already playing, and returns metadata and cost info for queuing
router.post('/api/playlists/quote', isAuthenticated, async (req, res) => {
    try {
        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = await getClassId();
        const allowedRow = await getAllowedPlaylist(playlistId, classId);
        if (!allowedRow || !allowedRow.is_allowed) {
            return res.status(403).json({ ok: false, error: 'This playlist is not allowed' });
        }

        await ensureSpotifyAccessToken();
        const fetchResult = await fetchPlaylistTracks(playlistId);
        if (fetchResult.error) {
            const fe = fetchResult.error;
            return res.status(fe.status === 403 ? 403 : fe.status === 429 ? 429 : 502).json({ ok: false, error: fe.message });
        }

        const rawItems = fetchResult.tracks;
        const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId, rawItems);
        if (alreadyPlaying) {
            return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
        }

        const playlistMeta = await spotifyApi.getPlaylist(playlistId);
        const quote = buildPlaylistQuoteFromItems(rawItems);
        const queueableCount = quote.playableCount;
        const cost = computePlaylistCost(queueableCount);
        const unplayable = Math.max(0, rawItems.length - queueableCount);

        return res.json({
            ok: true,
            playlist: {
                id: playlistId,
                name: playlistMeta.body?.name || allowedRow.name || 'Untitled Playlist'
            },
            queueableCount,
            tracks: quote.preview,
            totalTracks: quote.totalItems,
            previewCapped: quote.previewCapped,
            skipped: {
                unplayable,
                banned: 0,
                duplicate: 0
            },
            cost
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'quote playlist');
    }
});

// checks if playlist is allowed, counts playable tracks, checks if it's already playing, verifies payment and user status, then starts playback and logs the transaction
router.post('/api/playlists/queue', isAuthenticated, playbackRateLimit(MODIFY), async (req, res) => {
    try {
        const userId = req.session?.token?.id;
        if (!userId) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }

        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const classId = await getClassId();
        const allowedRow = await getAllowedPlaylist(playlistId, classId);
        console.log(`[playlist:queue] userId=${userId} playlistId=${playlistId} classId=${classId} allowedRow=${JSON.stringify(allowedRow)}`);
        if (!allowedRow || !allowedRow.is_allowed) {
            console.warn(`[playlist:queue] Blocked — playlist not allowed. allowedRow=${JSON.stringify(allowedRow)} classId=${classId}`);
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

        if (playlistStats.fetchError) {
            const fe = playlistStats.fetchError;
            return res.status(fe.status === 403 ? 403 : fe.status === 429 ? 429 : 502).json({ ok: false, error: fe.message });
        }

        if (!queueableCount) {
            return res.status(400).json({ ok: false, error: 'No queueable tracks found in this playlist', skipped: playlistStats.skipped });
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

// Teacher only: Unban a track by name/artist, removing from the banned_songs table 
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
        const { name, artist, reason, uri, image } = req.body || {};
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

        const imageUrl = typeof image === 'string' ? image : null;

        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO banned_songs (track_name, artist_name, track_uri, banned_by, reason, image_url) VALUES (?, ?, ?, ?, ?, ?)',
                [name, artist, uri || null, bannedBy, banReason, imageUrl],
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

// Fetches the current Spotify queue, merges with metadata from the database, and returns the combined data
router.get('/getQueue', playbackRateLimit(READ), async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await executePlaybackRead(req, 'getQueue', async () => fetch('https://api.spotify.com/v1/me/player/queue', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        }));
        if (response.status === 429) {
            setSpotifyPlaybackCooldown(READ, response.headers.get('retry-after'), 'GET /getQueue');
            return res.status(429).json({ ok: false, error: 'Spotify queue is rate limited. Please retry shortly.' });
        }
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

router.post('/addToQueue', playbackRateLimit(MODIFY), async (req, res) => {
    //console.log('addToQueue - Session:', req.session?.token?.id, 'hasPaid:', req.session?.hasPaid);
    if (!req.session || !req.session.token || !req.session.token.id) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (isOwner(req.session.token.id)) {
        try {
            await ensureSpotifyAccessToken();

            const { uri, anonMode, trackName: clientName, trackArtist: clientArtist, trackImage: clientImage } = req.body;
            if (!uri) return res.status(400).json({ error: "Missing track URI" });

            const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
            const match = uri.match(trackIdPattern);
            if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

            const trackId = match[1];

            // Use client-supplied metadata when available to avoid an extra Spotify API call.
            // Fall back to getTrack() only when metadata is missing (e.g. direct API calls).
            const trimName = typeof clientName === 'string' ? clientName.trim() : '';
            const trimArtist = typeof clientArtist === 'string' ? clientArtist.trim() : '';
            let track;
            if (trimName && trimArtist) {
                track = {
                    name: trimName.slice(0, 200),
                    artists: [{ name: trimArtist.slice(0, 200) }],
                    uri,
                    album: { images: [{ url: typeof clientImage === 'string' ? clientImage : '' }] }
                };
            } else {
                const trackData = await spotifyApi.getTrack(trackId);
                track = trackData.body;
            }
            const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');
            const isAnon = anonMode ? 1 : 0;

            const trackInfo = {
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                cover: track.album.images[0]?.url || '',
                addedBy: username
            };

            await executePlaybackModify(req, 'addToQueue', () => spotifyApi.addToQueue(shouldAprilFool() ? APRIL_FOOLS_URI : uri));

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

            // Save metadata to database (synchronously)
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
                imageURL: trackInfo.cover || null,
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
            return handleSpotifyError(err, res, 'addToQueue');
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

        const { uri, anonMode, trackName: clientName, trackArtist: clientArtist, trackImage: clientImage } = req.body;
        if (!uri) return res.status(400).json({ error: "Missing track URI" });

        const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
        const match = uri.match(trackIdPattern);
        if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

        const trackId = match[1];

        // Use client-supplied metadata when available to avoid an extra Spotify API call.
        // Fall back to getTrack() only when metadata is missing (e.g. direct API calls).
        const trimName = typeof clientName === 'string' ? clientName.trim() : '';
        const trimArtist = typeof clientArtist === 'string' ? clientArtist.trim() : '';
        let track;
        if (trimName && trimArtist) {
            track = {
                name: trimName.slice(0, 200),
                artists: [{ name: trimArtist.slice(0, 200) }],
                uri,
                album: { images: [{ url: typeof clientImage === 'string' ? clientImage : '' }] }
            };
        } else {
            const trackData = await spotifyApi.getTrack(trackId);
            track = trackData.body;
        }
        const isAnon = anonMode ? 1 : 0;
        const trackInfo = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            uri: track.uri,
            cover: track.album.images[0]?.url || '',
        };

        // Check banned songs
        if (await isTrackBannedByNameArtist(trackInfo.name, trackInfo.artist)) {
            return res.status(403).json({ ok: false, error: 'This track has been banned by the teacher' });
        }

        await executePlaybackModify(req, 'addToQueue', () => spotifyApi.addToQueue(shouldAprilFool() ? APRIL_FOOLS_URI : uri));
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
            imageURL: trackInfo.cover || null,
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
        return handleSpotifyError(err, res, 'addToQueue');
    }
});

// Fetches the currently playing track from Spotify, checks if something is playing, and returns the track info or an empty response if nothing is playing
router.get('/currentlyPlaying', playbackRateLimit(READ), async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await executePlaybackRead(req, 'currentlyPlaying', async () => fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        }));
        if (response.status === 429) {
            setSpotifyPlaybackCooldown(READ, response.headers.get('retry-after'), 'GET /currentlyPlaying');
            return res.status(429).json({ ok: false, error: 'Spotify playback is rate limited. Please retry shortly.' });
        }
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

router.post('/skip', playbackRateLimit(MODIFY), async (req, res) => {
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

            await executePlaybackModify(req, 'skip', () => spotifyApi.skipToNext());

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
                const currentPlayback = await executePlaybackRead(req, 'skip-currentTrack', () => spotifyApi.getMyCurrentPlayingTrack());
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
        await executePlaybackModify(req, 'skip', () => spotifyApi.skipToNext());

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
router.post('/queue/skip', playbackRateLimit(MODIFY), async (req, res) => {
    try {
        // Check permissions
        if (req.session.permission < 4 && !isOwner(req.session.token?.id)) {
            return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
        }

        const nextTrack = await queueManager.skipTrack(req.session.user || 'Teacher');

        if (nextTrack) {
            // Actually skip on Spotify
            await ensureSpotifyAccessToken();
            await executePlaybackModify(req, 'queue-skip', () => spotifyApi.skipToNext());

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

// Purchase skip shields for a track
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
                // console.log('[purchaseShield] Auto-refund issued for failed shield purchase');
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

// Endpoint to get the currently playing track with more direct Spotify API access 
router.get('/api/currentTrack', playbackRateLimit(READ), async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await executePlaybackRead(req, 'api-currentTrack', async () => fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        }));
        if (response.status === 429) {
            setSpotifyPlaybackCooldown(READ, response.headers.get('retry-after'), 'GET /api/currentTrack');
            return res.status(429).json({ ok: false, error: 'Spotify playback is rate limited. Please retry shortly.' });
        }
        const data = await response.json();
        res.json({ track: data.item });
    } catch (err) {
        console.error('Error fetching current track:', err);
        res.status(500).json({ error: 'Failed to fetch current track' });
    }
});

// Spotify auth/permission diagnostic endpoint
router.get('/diagnostics', isAuthenticated, requireTeacherAccess, async (req, res) => {
    const results = {
        timestamp: new Date().toISOString(),
        tests: {}
    };

    // spotify-web-api-node WebapiError sets error.message = String(body) when the body
    // object is passed directly to the Error constructor, producing "[object Object]".
    // Fall through that sentinel and extract from error.body instead.
    function extractErrMsg(error, fallback) {
        const raw = error?.message;
        if (typeof raw === 'string' && raw && raw !== '[object Object]') return raw;
        // WebapiError stores the original response body in .body
        const bodyMsg = error?.body?.error?.message;
        if (typeof bodyMsg === 'string' && bodyMsg) return bodyMsg;
        if (error?.body && typeof error.body === 'object') {
            try {
                const serialized = JSON.stringify(error.body);
                if (serialized && serialized !== '{}' && serialized !== '[]') return serialized;
            } catch { /* circular ref — ignore */ }
        }
        if (error?.statusCode) {
            const retryAfter = error?.headers?.['retry-after'];
            if (error.statusCode === 429) {
                return retryAfter
                    ? `Spotify rate limit hit (429). Retry after ${retryAfter}s.`
                    : 'Spotify rate limit hit (429). Please wait and retry.';
            }
            return `Spotify returned HTTP ${error.statusCode}`;
        }
        return fallback;
    }

    try {
        await ensureSpotifyAccessToken();

        // Test 1: getMe - verify user access
        // Note: the `product` field (Premium status) was removed from the User object for
        // Development Mode apps in the February 2026 Spotify API changes.
        try {
            const me = await spotifyApi.getMe();
            results.tests.userAccess = {
                status: 'pass',
                message: 'Successfully retrieved user info',
                user: me.body?.display_name || 'Unknown',
                note: 'Premium status cannot be verified via API for Development Mode apps (product field removed Feb 2026)'
            };
        } catch (error) {
            results.tests.userAccess = {
                status: 'fail',
                message: extractErrMsg(error, 'Failed to get user info'),
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        // Test 2: searchTracks - verify search scope
        try {
            const searchResult = await spotifyApi.searchTracks('test', { limit: 1 });
            results.tests.searchScope = {
                status: 'pass',
                message: 'Search endpoint working',
                totalResults: searchResult.body?.tracks?.total || 0
            };
        } catch (error) {
            results.tests.searchScope = {
                status: error.statusCode === 429 ? 'warning' : 'fail',
                message: extractErrMsg(error, 'Search failed'),
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        // Test 3: getTrack - verify track metadata access
        try {
            const trackResult = await spotifyApi.getTrack('3n3Ppam7vgaVa1iaRUc9Lp');
            results.tests.trackLookup = {
                status: 'pass',
                message: 'Track lookup working',
                track: trackResult.body?.name || 'Unknown',
                hasImage: !!(trackResult.body?.album?.images?.length > 0)
            };
        } catch (error) {
            results.tests.trackLookup = {
                status: error.statusCode === 429 ? 'warning' : 'fail',
                message: extractErrMsg(error, 'Track lookup failed'),
                statusCode: error.statusCode,
                note: error.statusCode === 429 ? 'Rate limited — app is making too many requests. Wait and retry.' : undefined,
                errorBody: error.body?.error || null
            };
        }

        // Test 4: getMyCurrentPlayingTrack - verify playback-state read scope
        try {
            const playback = await executePlaybackRead(req, 'diagnostics-playbackRead', () => spotifyApi.getMyCurrentPlayingTrack());
            const isPlaying = !!playback.body?.item;
            results.tests.playbackRead = {
                status: 'pass',
                message: 'Playback state readable',
                isCurrentlyPlaying: isPlaying,
                currentTrack: isPlaying ? playback.body.item.name : null
            };
        } catch (error) {
            results.tests.playbackRead = {
                status: error.statusCode === 429 ? 'warning' : 'fail',
                message: extractErrMsg(error, 'Failed to read playback state'),
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        // Test 5: addToQueue - verify playback-modify scope (dry-run check)
        try {
            // We won't actually add to queue, just check if the scope is available
            // by attempting a getMyDevices call which requires user-read-playback-state
            const deviceResult = await executePlaybackRead(req, 'diagnostics-playbackModifyCheck', () => spotifyApi.getMyDevices());
            const hasDevice = (deviceResult.body?.devices?.length || 0) > 0;
            results.tests.playbackModify = {
                status: hasDevice ? 'pass' : 'warning',
                message: hasDevice ? 'Playback modify scope available' : 'No active devices found',
                activeDevices: deviceResult.body?.devices?.length || 0,
                deviceNames: deviceResult.body?.devices?.map(d => d.name) || []
            };
        } catch (error) {
            results.tests.playbackModify = {
                status: error.statusCode === 429 ? 'warning' : 'fail',
                message: extractErrMsg(error, 'Failed to check playback modify scope'),
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        // Test 6: Summary
        const passCount = Object.values(results.tests).filter(t => t.status === 'pass').length;
        const failCount = Object.values(results.tests).filter(t => t.status === 'fail').length;
        const warnCount = Object.values(results.tests).filter(t => t.status === 'warning').length;

        results.summary = {
            passed: passCount,
            failed: failCount,
            warnings: warnCount,
            allPassed: failCount === 0,
            recommendation: failCount > 0 
                ? 'One or more tests failed. Check the details above. You may need to re-generate your refresh token with all required scopes.'
                : warnCount > 0
                ? 'All tests passed but some warnings detected. Check details above.'
                : 'All tests passed. Spotify credentials appear to be working correctly.'
        };

        res.json(results);
    } catch (error) {
        console.error('Diagnostics endpoint error:', error);
        results.error = error.message;
        res.status(500).json(results);
    }
});

// --- Artist / Album browsing routes ---

router.get('/api/artist/:id/top-tracks', async (req, res) => {
    try {
        const { id } = req.params;
        const artistName = (req.query.name || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'Artist ID required' });
        if (!artistName) return res.status(400).json({ ok: false, error: 'Artist name required (pass ?name=)' });

        const lastfmKey = process.env.LASTFM_API_KEY;
        if (!lastfmKey) return res.status(500).json({ ok: false, error: 'LASTFM_API_KEY not configured' });

        // Step 1: Get ranked track names from Last.fm
        const lfmUrl = new URL('https://ws.audioscrobbler.com/2.0/');
        lfmUrl.searchParams.set('method', 'artist.getTopTracks');
        lfmUrl.searchParams.set('artist', artistName);
        lfmUrl.searchParams.set('limit', '15');
        lfmUrl.searchParams.set('api_key', lastfmKey);
        lfmUrl.searchParams.set('format', 'json');

        const lfmRes = await fetch(lfmUrl.toString());
        if (!lfmRes.ok) {
            console.error(`[top-tracks] Last.fm ${lfmRes.status}`);
            return res.status(502).json({ ok: false, error: 'Last.fm request failed' });
        }
        const lfmData = await lfmRes.json();
        const lfmTracks = lfmData.toptracks?.track || [];
        if (!lfmTracks.length) return res.json({ ok: true, tracks: [] });

        // Step 2: Resolve each track name to a Spotify track via search, keeping Last.fm order
        await ensureSpotifyAccessToken();

        const banned = await getBannedSongs();
        const bannedPairs = new Set(banned.map(b =>
            `${(b.track_name || '').trim().toLowerCase()}::${(b.artist_name || '').trim().toLowerCase()}`
        ));

        const resolved = [];
        for (const lfmTrack of lfmTracks) {
            if (resolved.length >= 10) break;
            const trackName = lfmTrack.name || '';
            try {
                const searchData = await spotifyApi.searchTracks(
                    `track:"${trackName.replace(/"/g, '')}" artist:"${artistName.replace(/"/g, '')}"`,
                    { limit: SPOTIFY_SEARCH_LIMIT_MAX, market: 'US' }
                );
                const candidates = (searchData.body.tracks?.items || [])
                    .filter(t => (t.artists || []).some(a => a.id === id));

                const match = candidates.find(
                    t => !t.explicit && (t.duration_ms || 0) < 420000 && !isTrackBanned(t, bannedPairs)
                );
                if (!match) continue;

                // Avoid duplicate Spotify tracks (same URI)
                if (resolved.some(r => r.uri === match.uri)) continue;

                resolved.push({
                    id: match.id,
                    name: match.name,
                    artist: (match.artists || []).map(a => a.name).join(', '),
                    uri: match.uri,
                    album: {
                        name: match.album?.name || '',
                        image: match.album?.images?.[0]?.url || null
                    },
                    duration_ms: match.duration_ms
                });
            } catch (searchErr) {
                console.warn(`[top-tracks] Spotify search failed for "${trackName}":`, formatSpotifyErrorForLog(searchErr));
                if (searchErr?.statusCode === 429) break;
            }
        }

        return res.json({ ok: true, tracks: resolved });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch artist top tracks');
    }
});

// Get albums for an artist, paginated
router.get('/api/artist/:id/albums', async (req, res) => {
    try {
        const { id } = req.params;
        const offset = parseInt(req.query.offset, 10) || 0;
        if (!id) return res.status(400).json({ ok: false, error: 'Artist ID required' });

        await ensureSpotifyAccessToken();

        const url = new URL(`https://api.spotify.com/v1/artists/${id}/albums`);
        url.searchParams.set('include_groups', 'album,single');
        url.searchParams.set('market', 'US');
        url.searchParams.set('limit', '10'); // Spotify API maximum for this endpoint
        url.searchParams.set('offset', String(offset));

        const response = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` }
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            return res.status(response.status).json({ ok: false, error: errBody?.error?.message || `Spotify error ${response.status}` });
        }

        const data = await response.json();
        const albums = (data.items || []).map(a => ({
            id: a.id,
            name: a.name,
            image: a.images?.[0]?.url || null,
            release_date: a.release_date || '',
            total_tracks: a.total_tracks || 0,
            album_type: a.album_type || 'album'
        }));

        const nextOffset = offset + albums.length;
        const hasMore = nextOffset < (data.total || 0);

        return res.json({ ok: true, albums, hasMore, nextOffset });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch artist albums');
    }
});

// Get tracks for an album, filtering out explicit, local, long, and banned tracks
router.get('/api/album/:id/tracks', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ ok: false, error: 'Album ID required' });

        await ensureSpotifyAccessToken();
        const result = await spotifyApi.getAlbum(id, { market: 'US' });
        const albumData = result.body;
        const albumImage = albumData.images?.[0]?.url || null;
        const releaseYear = typeof albumData.release_date === 'string'
            ? albumData.release_date.substring(0, 4)
            : '';

        const banned = await getBannedSongs();
        const bannedPairs = new Set(banned.map(b =>
            `${(b.track_name || '').trim().toLowerCase()}::${(b.artist_name || '').trim().toLowerCase()}`
        ));

        const filtered = [];
        for (const t of (albumData.tracks?.items || [])) {
            if (!t.uri || t.is_local) continue;
            if ((t.duration_ms || 0) >= 420000) continue;
            if (t.explicit) continue;
            if (isTrackBanned(t, bannedPairs)) continue;
            filtered.push({
                id: t.id,
                name: t.name,
                artist: (t.artists || []).map(a => a.name).join(', '),
                uri: t.uri,
                album: { name: albumData.name || '', image: albumImage },
                duration_ms: t.duration_ms || 0
            });
        }

        return res.json({
            ok: true,
            tracks: filtered,
            queueableCount: filtered.length,
            releaseYear
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch album tracks');
    }
});

module.exports = router;
