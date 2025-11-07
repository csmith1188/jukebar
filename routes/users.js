const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');

// Middleware to check if user has teacher permissions
const requireTeacherAccess = (req, res, next) => {
    if (req.session.permission >= 4 || req.session.token?.id === Number(process.env.OWNER_ID)) {
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
            db.all("SELECT id, displayName FROM users ORDER BY displayName COLLATE NOCASE", (err, rows) => {
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

// Ban a user
router.post('/api/users/ban', isAuthenticated, requireTeacherAccess, async (req, res) => {
    try {
        const { username } = req.body;
        const db = require('../utils/database');
        
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
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
        res.json({ success: true, message: `User ${username} has been unbanned` });
    } catch (error) {
        console.error('Error unbanning user:', error);
        res.status(500).json({ error: 'Failed to unban user' });
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