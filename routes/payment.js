const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const { isOwner, getFirstOwnerId } = require('../utils/owners');
const { transfer, refund: poolRefund } = require('../utils/transferManager');

const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const POOL_ID = Number(process.env.POOL_ID);

if (!POOL_ID || isNaN(POOL_ID)) {
    console.error('[payment.js] FATAL: POOL_ID is not set or invalid in .env. Payments will be rejected.');
}

function computePlaylistCost(trackCount) {
    const songAmount = Number(process.env.SONG_AMOUNT) || 50;
    return Math.min(trackCount * songAmount, 500);
}

// Returns the top non-owner user IDs ranked by plays in the last 7 days (same source as the leaderboard)
function getRollingTopUsers() {
    return new Promise((resolve, reject) => {
        const ownerIds = require('../utils/owners').getOwnerIds();
        const ownerFilter = ownerIds.length
            ? `AND t.user_id NOT IN (${ownerIds.map(() => '?').join(',')})`
            : '';

        db.all(
            `SELECT t.user_id as id
             FROM transactions t
             WHERE t.action = 'play'
               AND t.timestamp >= datetime('now', '-7 days')
               ${ownerFilter}
             GROUP BY t.user_id
             ORDER BY COUNT(*) DESC
             LIMIT 10`,
            ownerIds,
            (err, rows) => {
                if (err) return reject(err);
                resolve((rows || []).map(r => Number(r.id)));
            }
        );
    });
}

async function fetchPlaylistTrackItems(playlistId) {
    await ensureSpotifyAccessToken();
    const items = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const response = await spotifyApi.getPlaylistTracks(playlistId, { limit, offset });
        const batch = response.body?.items || [];
        items.push(...batch);
        if (batch.length < limit) break;
        offset += limit;
    }

    return items;
}

async function getCurrentTrackUri() {
    await ensureSpotifyAccessToken();
    const playback = await spotifyApi.getMyCurrentPlayingTrack();
    return playback?.body?.item?.uri || null;
}

async function isPlaylistCurrentlyPlaying(playlistId, playlistItems = null) {
    const currentTrackUri = await getCurrentTrackUri();
    if (!currentTrackUri) return false;

    const items = playlistItems || await fetchPlaylistTrackItems(playlistId);
    return items.some((item) => item?.track?.uri === currentTrackUri);
}

async function getPlaylistPlayableTrackCount(playlistId, playlistItems = null) {
    const items = playlistItems || await fetchPlaylistTrackItems(playlistId);
    let playableCount = 0;

    for (const item of items) {
        const track = item?.track;
        if (!track || track.is_local || !track.uri || !track.uri.startsWith('spotify:track:')) {
            continue;
        }
        playableCount += 1;
    }

    return playableCount;
}

function isPlaylistAllowed(playlistId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT is_allowed FROM allowed_playlists WHERE spotify_playlist_id = ?',
            [playlistId],
            (err, row) => {
                if (err) return reject(err);
                resolve(!!row?.is_allowed);
            }
        );
    });
}

router.post('/transfer', async (req, res) => {
    try {
        const to = POOL_ID;
        if (!to || isNaN(to)) {
            return res.status(500).json({ ok: false, error: 'Server misconfigured: POOL_ID is not set. Contact your administrator.' });
        }
        let { pin, reason, playlistId } = req.body || {};
        const pendingAction = req.body?.pendingAction;
        
        console.log('=== PAYMENT TRANSFER REQUEST ===');
        console.log('pendingAction:', pendingAction);
        console.log('reason:', reason);

        //gets the top 3 users to apply a discount (filter out ALL owners)
        const topUsers = await getRollingTopUsers();

        const userRow = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE id = ?", [req.session.token?.id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        // Compute amount on the server; do NOT trust client-provided amount
        let amount;
        if (pendingAction === 'skip') {
            // Skips are a fixed cost (no discounts)
            amount = Number(process.env.SKIP_AMOUNT) || 100;
        } else if (pendingAction === 'playlist') {
            if (!playlistId) {
                return res.status(400).json({ ok: false, error: 'playlistId is required for playlist payments' });
            }
            const allowed = await isPlaylistAllowed(playlistId);
            if (!allowed) {
                return res.status(403).json({ ok: false, error: 'This playlist is not allowed' });
            }
            const playlistItems = await fetchPlaylistTrackItems(playlistId);
            const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId, playlistItems);
            if (alreadyPlaying) {
                return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
            }
            const queueableCount = await getPlaylistPlayableTrackCount(playlistId, playlistItems);
            amount = computePlaylistCost(queueableCount);
            if (amount <= 0) {
                return res.status(400).json({ ok: false, error: 'No queueable tracks found in this playlist' });
            }
        } else if (pendingAction === 'Skip Shield') {
            // Skip Shields are a fixed cost (no discounts)
            amount = Number(process.env.SKIP_SHIELD) || 75;
        } else if (pendingAction === 'Ban Vote') {
            // Ban Votes are a fixed cost (no discounts)
            amount = Number(process.env.VOTE_BAN_AMOUNT) || 500;
        } else if (pendingAction === 'createPlaylist') {
            amount = Number(process.env.CREATE_PLAYLIST_AMOUNT) || 700;
        } else if (pendingAction === 'addPlaylistSong') {
            amount = Number(process.env.ADD_PLAYLIST_SONG_AMOUNT) || 100;
        } else if (pendingAction === 'removePlaylistSong') {
            amount = Number(process.env.REMOVE_PLAYLIST_SONG_AMOUNT) || 50;
        } else {
            amount = Number(process.env.SONG_AMOUNT) || 50;
            if (userRow && userRow.id) {
                const userIdNum = Number(userRow.id);
                if (topUsers[0] === userIdNum) {
                    amount = Math.max(0, amount - 10);
                } else if (topUsers[1] === userIdNum) {
                    amount = Math.max(0, amount - 5);
                } else if (topUsers[2] === userIdNum) {
                    amount = Math.max(0, amount - 3);
                }
            }
        }

        //console.log('Received PIN:', pin, 'Type:', typeof pin);
        //console.log('User session ID:', req.session.token?.id);
        //console.log('User row from DB:', userRow);

        if (!userRow || !userRow.id) {
            console.error('Transfer failed: User not found in database. Session token:', req.session.token);
            return res.status(400).json({ ok: false, error: 'User not found. Please log in again or contact support.' });
        }
        if (!to || !amount || pin == null) {
            console.error('Transfer failed: Missing required fields.', { to, amount, pin });
            return res.status(400).json({ ok: false, error: 'Missing required fields for transfer. Please try again.' });
        }
        const payload = {
            from: Number(userRow.id),
            to: Number(to),
            amount: Number(amount),
            pin: Number(pin),
            reason: String(reason),
        };

        console.log('=== FORMBAR TRANSFER REQUEST ===');
        console.log('Transfer payload being sent to Formbar:', payload);
        
        try {
            // Use socket-based pool transfer
            const responseJson = await transfer({
                from: payload.from,
                to: payload.to,
                amount: payload.amount,
                pin: payload.pin,
                reason: payload.reason
            });

            console.log('Transfer response:', JSON.stringify(responseJson, null, 2));
            console.log('================================');

            // Transfer succeeded
            req.session.hasPaid = true;
            req.session.payment = {
                from: Number(userRow.id),
                to: Number(to),
                amount: Number(amount),
                pendingAction: pendingAction || null,
                playlistId: (pendingAction === 'playlist' || pendingAction === 'addPlaylistSong' || pendingAction === 'removePlaylistSong') ? String(playlistId || '') : null,
                at: Date.now()
            };
            return req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ ok: false, error: 'Session save failed' });
                }
                res.json({ ok: true, message: 'Transfer successful', response: responseJson });
            });
        } catch (transferError) {
            // Transfer failed - extract error message
            const specificError = transferError.message || 'Transfer failed';
            console.log('Transfer error:', specificError);

            res.status(400).json({
                ok: false,
                error: specificError,
                details: transferError.details || null
            });
        }
    } catch (err) {
        res.status(502).json({ ok: false, error: 'HTTP request to Formbar failed', details: err?.message || String(err) });
    }
});

router.post('/refund', async (req, res) => {
    try {
        const reason = "Jukebar refund";
        
        // Get the first owner's ID
        const firstOwnerId = getFirstOwnerId();
        if (!firstOwnerId) {
            return res.status(500).json({ ok: false, error: 'Server misconfigured: No owner ID found' });
        }
        
        // Get owner's PIN from environment variable
        const pin = process.env.OWNER_PIN;
        if (!pin) {
            return res.status(500).json({ ok: false, error: 'Server misconfigured: OWNER_PIN not set' });
        }
        
        const userRow = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE id = ?", [req.session.token?.id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        // Basic authz checks
        if (!userRow || !userRow.id) {
            return res.status(401).json({ ok: false, error: 'Not authenticated' });
        }

        // Require a recent, unclaimed payment to exist in session and prevent double-refunds
        const lastPayment = req.session.payment || null;
        const now = Date.now();
        const refundableWindowMs = 15 * 60 * 1000; // 15 minutes

        if (!lastPayment) {
            return res.status(400).json({ ok: false, error: 'No payment found to refund' });
        }
        if (lastPayment.refundedAt) {
            return res.status(409).json({ ok: false, error: 'Payment already refunded' });
        }
        if (lastPayment.from !== Number(userRow.id)) {
            return res.status(403).json({ ok: false, error: 'Payment does not belong to this user' });
        }
        if (!req.session.hasPaid) {
            // If the service has already claimed the payment, do not allow refund via this endpoint
            return res.status(409).json({ ok: false, error: 'Payment already claimed' });
        }
        if (!lastPayment.at || (now - lastPayment.at) > refundableWindowMs) {
            return res.status(408).json({ ok: false, error: 'Refund window expired' });
        }
        
        // Refund comes from the first owner, not from the pool
        const from = firstOwnerId;

        // Refund the exact amount of the last payment
        const amount = Number(lastPayment.amount);
        if (!amount || amount <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid payment amount for refund' });
        }

        const payload = {
            from: Number(from),
            to: Number(userRow.id),
            amount: Number(amount),
            pin: Number(pin),
            reason: String(reason),
        };

        try {
            // Use socket-based pool transfer for refund
            const responseJson = await poolRefund({
                from: payload.from,
                to: payload.to,
                amount: payload.amount,
                pin: payload.pin,
                reason: payload.reason
            });

            // Refund succeeded
            req.session.payment.refundedAt = Date.now();
            req.session.hasPaid = false;
            return req.session.save(() => {
                res.json({ ok: true, message: 'Refund successful', response: responseJson });
            });
        } catch (transferError) {
            const specificError = transferError.message || 'Refund failed';
            res.status(400).json({
                ok: false,
                error: specificError,
                details: transferError.details || null
            });
        }
    } catch (err) {
        console.error('Refund error:', err);
        res.status(502).json({ ok: false, error: 'Transfer to Formbar failed', details: err?.message || String(err) });
    }
});

router.post('/savePin', (req, res) => {
    const { pin } = req.body || {};

    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN is required' });
    }

    if (!req.session.token || !req.session.token.id) {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    //console.log('Saving PIN for user', req.session.token.id);
    db.run("UPDATE users SET pin = ? WHERE id = ?", [pin, req.session.token.id], function (err) {
        if (err) {
            console.error('Database error:', err.message);
            return res.status(500).json({ ok: false, error: 'Database error' });
        } else {
            //console.log('PIN saved for user', req.session.token.id);
            res.json({ ok: true });
        }
    });
});

router.post('/getPin', (req, res) => {
    if (!req.session.token || !req.session.token.id) {
        return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    db.get("SELECT pin FROM users WHERE id = ?", [req.session.token.id], (err, row) => {
        if (err) {
            console.error('Database error:', err.message);
            return res.status(500).json({ ok: false, error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        }
        res.json({ ok: true, userPin: row.pin || '' });
    });
});

router.post('/claimPayment', (req, res) => {
    try {
        if (!req.session?.hasPaid) {
            return res.status(402).json({ ok: false, error: 'Payment required' });
        }

        // this is so the user has to pay again after buying something
        req.session.hasPaid = false;
        req.session.save(() => {
            res.json({ ok: true, message: 'Payment claimed' });
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Failed to claim payment' });
    }
});

router.get('/paymentStatus', (req, res) => {
    res.json({ ok: true, hasPaid: !!req.session.hasPaid });
});

router.post('/getAmount', async (req, res) => {
    try {
        const db = require('../utils/database');
        const userId = req.session.token?.id;
        const pendingAction = req.body.pendingAction;
        const playlistId = req.body.playlistId;
        let amount;
        let discountApplied = false;

        if (pendingAction === 'skip') {
            amount = Number(process.env.SKIP_AMOUNT) || 100;
        } else if (pendingAction === 'playlist') {
            if (!playlistId) {
                return res.status(400).json({ ok: false, error: 'playlistId is required for playlist amount' });
            }
            const allowed = await isPlaylistAllowed(playlistId);
            if (!allowed) {
                return res.status(403).json({ ok: false, error: 'This playlist is not allowed' });
            }
            const playlistItems = await fetchPlaylistTrackItems(playlistId);
            const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId, playlistItems);
            if (alreadyPlaying) {
                return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
            }
            const queueableCount = await getPlaylistPlayableTrackCount(playlistId, playlistItems);
            amount = computePlaylistCost(queueableCount);
        } else if (pendingAction === 'Skip Shield') {
            amount = Number(process.env.SKIP_SHIELD) || 75;
        } else if (pendingAction === 'Ban Vote') {
            amount = Number(process.env.VOTE_BAN_AMOUNT) || 500;
        } else if (pendingAction === 'createPlaylist') {
            amount = Number(process.env.CREATE_PLAYLIST_AMOUNT) || 700;
        } else if (pendingAction === 'addPlaylistSong') {
            amount = Number(process.env.ADD_PLAYLIST_SONG_AMOUNT) || 100;
        } else if (pendingAction === 'removePlaylistSong') {
            amount = Number(process.env.REMOVE_PLAYLIST_SONG_AMOUNT) || 50;
        } else {
            amount = Number(process.env.SONG_AMOUNT) || 50;
            // Get top 3 user IDs from the rolling 7-day leaderboard (same source as the displayed leaderboard)
            const topUsers = await getRollingTopUsers();
            // discount
            if (userId) {
                const userIdNum = Number(userId);
                if (topUsers[0] === userIdNum) {
                    amount = Math.max(0, amount - 10); //10 pogs off
                    discountApplied = true;
                } else if (topUsers[1] === userIdNum) {
                    amount = Math.max(0, amount - 5);  //5 pogs off
                    discountApplied = true;
                } else if (topUsers[2] === userIdNum) {
                    amount = Math.max(0, amount - 3);  //3 pogs off
                    discountApplied = true;
                }
            }
        }
        res.json({ ok: true, amount, discountApplied });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// TEMPORARY TEST ENDPOINT - REMOVE IN PRODUCTION
router.post('/testPayment', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ ok: false, error: 'Disabled in production' });
    }
    if (!req.session || !req.session.token) {
        return res.status(401).json({ ok: false, error: 'Not logged in' });
    }
    req.session.hasPaid = true;
    req.session.save(() => {
        res.json({ ok: true, message: 'Payment flag set for testing' });
    });
});

module.exports = router;
