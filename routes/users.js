const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const { isOwner } = require('../utils/owners');

// Middleware to check if user has teacher permissions
const requireTeacherAccess = (req, res, next) => {
    if (req.session.permission >= 4 || isOwner(req.session.token?.id)) {
        next();
    } else {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
};

// Get all users (for teacher panel)
router.get('/api/users', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const db = require('../utils/database');
        
        // Get all users from database
        const users = await new Promise((resolve, reject) => {
            db.all("SELECT id, displayName, COALESCE(isBanned, 0) as isBanned, COALESCE(permission, 2) as permission FROM users ORDER BY displayName COLLATE NOCASE", (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
        
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get queue history (play transactions only)
router.get('/api/queueHistory', isAuthenticated, requireTeacherAccess, async (req, res) => {
    console.log('Queue history endpoint hit - User:', req.session.user, 'Permission:', req.session.permission);
    try {
        const db = require('../utils/database');
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;
        
        console.log('Fetching queue history - limit:', limit, 'offset:', offset);
        
        // Get play transactions with user info
        const plays = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    t.track_name,
                    t.artist_name,
                    t.track_uri,
                    t.display_name as user,
                    t.timestamp,
                    datetime(t.timestamp) as formatted_time
                FROM transactions t
                WHERE t.action = 'play'
                ORDER BY t.timestamp DESC
                LIMIT ? OFFSET ?
            `, [limit, offset], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });

        // Fetch album art from Spotify in a single batch call (up to 50 at once)
        const imageMap = {};
        try {
            await ensureSpotifyAccessToken();
            const trackIds = plays
                .filter(p => p.track_uri)
                .map(p => p.track_uri.replace('spotify:track:', ''));
            if (trackIds.length > 0) {
                const batchData = await spotifyApi.getTracks(trackIds);
                batchData.body.tracks.forEach(track => {
                    if (track) imageMap[track.uri] = track.album.images?.[0]?.url || null;
                });
            }
        } catch (err) {
            console.warn('Could not fetch album art batch:', err.message);
        }

        const enrichedPlays = plays.map(play => ({
            ...play,
            albumImage: imageMap[play.track_uri] || '/img/placeholder.png'
        }));

        res.json({ ok: true, plays: enrichedPlays });
    } catch (error) {
        console.error('Error fetching queue history:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch queue history' });
    }
});

// Ban a user
router.post('/api/users/ban', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { username } = req.body;
        const db = require('../utils/database');
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        // Check if target user is a teacher or owner — cannot ban them
        const targetUser = await new Promise((resolve, reject) => {
            db.get("SELECT id, COALESCE(permission, 2) as permission FROM users WHERE displayName = ?", [username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (targetUser.permission >= 4 || isOwner(targetUser.id)) {
            return res.status(403).json({ error: 'Cannot ban a teacher or owner' });
        }

        // Update user's banned status in database
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET isBanned = 1 WHERE displayName = ?", [username], function(err) {
                if (err) {
                    reject(err);
                } else if (this.changes === 0) {
                    reject(new Error('User not found'));
                } else {
                    resolve();
                }
            });
        });
        
        console.log(`Banning user: ${username}`);

        // Emit real-time ban event to all clients
        const io = req.app.get('io');
        if (io) {
            io.emit('userBanned', { userId: targetUser.id, username });
        }

        res.json({ success: true, message: `User ${username} has been banned` });
    } catch (error) {
        console.error('Error banning user:', error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// Unban a user
router.post('/api/users/unban', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { username } = req.body;
        const db = require('../utils/database');
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        // Update user's banned status in database
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET isBanned = 0 WHERE displayName = ?", [username], function(err) {
                if (err) {
                    reject(err);
                } else if (this.changes === 0) {
                    reject(new Error('User not found'));
                } else {
                    resolve();
                }
            });
        });
        
        console.log(`Unbanning user: ${username}`);

        // Emit real-time unban event to all clients
        const io = req.app.get('io');
        if (io) {
            // Look up the user's ID for targeted unban
            const unbannedUser = await new Promise((resolve, reject) => {
                db.get("SELECT id FROM users WHERE displayName = ?", [username], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (unbannedUser) {
                io.emit('userUnbanned', { userId: unbannedUser.id, username });
            }
        }

        res.json({ success: true, message: `User ${username} has been unbanned` });
    } catch (error) {
        console.error('Error unbanning user:', error);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// Get list of banned users (for teacher panel)
router.get('/api/users/banned', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const db = require('../utils/database');
        const users = await new Promise((resolve, reject) => {
            db.all("SELECT id, displayName FROM users WHERE isBanned = 1 ORDER BY displayName COLLATE NOCASE", (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        res.json(users);
    } catch (error) {
        console.error('Error fetching banned users:', error);
        res.status(500).json({ error: 'Failed to fetch banned users' });
    }
});

// Check if the current user is banned (student self-check)
router.get('/api/me/banned', isAuthenticated, async (req, res) => {
    try {
        const db = require('../utils/database');
        const userId = req.session.token?.id;
        if (!userId) return res.json({ banned: false });

        const user = await new Promise((resolve, reject) => {
            db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        res.json({ banned: !!(user && user.isBanned) });
    } catch (error) {
        console.error('Error checking ban status:', error);
        res.json({ banned: false });
    }
});

// Get user transactions
router.post('/api/users/transactions', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { username, page = 1, limit = 10 } = req.body;
        const db = require('../utils/database');
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        // First, get the user ID from the username
        const user = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE displayName = ?", [username], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get total count of transactions for this user
        const totalCount = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM transactions WHERE user_id = ?", [user.id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row.count);
                }
            });
        });

        // Get paginated transactions for this user
        const transactions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    track_name,
                    artist_name,
                    action,
                    cost,
                    timestamp,
                    datetime(timestamp) as formatted_time
                FROM transactions 
                WHERE user_id = ? 
                ORDER BY timestamp DESC 
                LIMIT ? OFFSET ?
            `, [user.id, limitNum, offset], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });

        const totalPages = Math.ceil(totalCount / limitNum);
        const hasNextPage = pageNum < totalPages;
        const hasPrevPage = pageNum > 1;

        res.json({ 
            success: true, 
            username: username,
            transactions: transactions,
            pagination: {
                currentPage: pageNum,
                totalPages: totalPages,
                totalCount: totalCount,
                hasNextPage: hasNextPage,
                hasPrevPage: hasPrevPage,
                limit: limitNum
            }
        });
    } catch (error) {
        console.error('Error fetching user transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// Get transaction modal partial
router.post('/api/users/transactions/modal', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { username, page = 1, limit = 10 } = req.body;
        const db = require('../utils/database');
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        // First, get the user ID from the username
        const user = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE displayName = ?", [username], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get total count of transactions for this user
        const totalCount = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM transactions WHERE user_id = ?", [user.id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row.count);
                }
            });
        });

        // Get paginated transactions for this user
        const transactions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    track_name,
                    artist_name,
                    action,
                    cost,
                    timestamp,
                    datetime(timestamp) as formatted_time
                FROM transactions 
                WHERE user_id = ? 
                ORDER BY timestamp DESC 
                LIMIT ? OFFSET ?
            `, [user.id, limitNum, offset], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });

        const totalPages = Math.ceil(totalCount / limitNum);
        const hasNextPage = pageNum < totalPages;
        const hasPrevPage = pageNum > 1;

        const pagination = {
            currentPage: pageNum,
            totalPages: totalPages,
            totalCount: totalCount,
            hasNextPage: hasNextPage,
            hasPrevPage: hasPrevPage,
            limit: limitNum
        };

        const html = await new Promise((resolve, reject) => {
            res.app.render('partials/transactions', {
                username: username,
                transactions: transactions,
                pagination: pagination
            }, (err, html) => {
                if (err) reject(err);
                else resolve(html);
            });
        });

        res.json({ success: true, html: html });
    } catch (error) {
        console.error('Error fetching transaction modal:', error);
        res.status(500).json({ error: 'Failed to fetch transaction modal' });
    }
});

module.exports = router;