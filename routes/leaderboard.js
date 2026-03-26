const express = require('express');
const router = express.Router();
const { getOwnerIds } = require('../utils/owners');

router.get('/api/leaderboard', async (req, res) => {
    try {
        const db = require('../utils/database');
        const ownerIds = getOwnerIds();
        const ownerPlaceholders = ownerIds.length
            ? `AND t.user_id NOT IN (${ownerIds.map(() => '?').join(',')})`
            : '';

        const leaderboardData = await new Promise((resolve, reject) => {
            db.all(
                `SELECT u.displayName, COUNT(*) as songsPlayed, COALESCE(u.isBanned, 0) as isBanned
                 FROM transactions t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.action = 'play'
                   AND t.timestamp >= datetime('now', '-7 days')
                   ${ownerPlaceholders}
                 GROUP BY t.user_id
                 ORDER BY songsPlayed DESC`,
                ownerIds,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });

        res.json({ ok: true, leaderboard: leaderboardData });
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

module.exports = { router };