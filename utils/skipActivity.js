const db = require('./database');

function getPositiveIntEnv(name, defaultValue, min, max) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw) || raw <= 0) return defaultValue;
    return Math.max(min, Math.min(max, Math.floor(raw)));
}

const MAX_STORED_SKIP_ACTIVITY = getPositiveIntEnv('SKIP_ACTIVITY_STORED_LIMIT', 100, 10, 1000);

function normalizeSkipType(type) {
    return type === 'shield' ? 'shield' : 'song';
}

function logSkipActivity({ skippedBy, skippedAt, skippedType, skippedTrack } = {}) {
    const actor = (skippedBy || 'Someone').toString();
    const timestamp = Number(skippedAt) || Date.now();
    const type = normalizeSkipType(skippedType);
    const trackName = (skippedTrack?.name || 'Unknown song').toString();
    const trackUri = skippedTrack?.uri ? skippedTrack.uri.toString() : null;

    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO skip_activity (skipped_by, skipped_at, skipped_type, skipped_track_name, skipped_track_uri)
             VALUES (?, ?, ?, ?, ?)`,
            [actor, timestamp, type, trackName, trackUri],
            (insertErr) => {
                if (insertErr) {
                    reject(insertErr);
                    return;
                }

                db.run(
                    `DELETE FROM skip_activity
                     WHERE id NOT IN (
                        SELECT id FROM skip_activity
                        ORDER BY skipped_at DESC, id DESC
                        LIMIT ?
                     )`,
                    [MAX_STORED_SKIP_ACTIVITY],
                    (cleanupErr) => {
                        if (cleanupErr) {
                            reject(cleanupErr);
                            return;
                        }
                        resolve();
                    }
                );
            }
        );
    });
}

function getRecentSkipActivity(limit = 5) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 5));

    return new Promise((resolve, reject) => {
        db.all(
            `SELECT skipped_by, skipped_at, skipped_type, skipped_track_name, skipped_track_uri
             FROM skip_activity
             ORDER BY skipped_at DESC, id DESC
             LIMIT ?`,
            [safeLimit],
            (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }

                const mapped = (rows || []).map((row) => ({
                    skippedBy: row.skipped_by || 'Someone',
                    skippedAt: Number(row.skipped_at) || Date.now(),
                    skippedType: normalizeSkipType(row.skipped_type),
                    skippedTrack: {
                        name: row.skipped_track_name || 'Unknown song',
                        uri: row.skipped_track_uri || null
                    }
                }));

                resolve(mapped);
            }
        );
    });
}

module.exports = {
    logSkipActivity,
    getRecentSkipActivity
};
