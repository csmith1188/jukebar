
const express = require('express');
const router = express.Router();

// leaderboard reset function
async function checkAndResetLeaderboard(app) {
    try {
        const now = new Date();
        const lastReset = new Date(app.get('leaderboardLastReset') || 0);
        
        // check if it's monday
        const isMonday = now.getDay() === 1;
        
        // Calculate the start of the week
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
        startOfThisWeek.setHours(0, 0, 0, 0);
        
        const needsReset = lastReset < startOfThisWeek;
        
        if (isMonday && needsReset) {
            const resetTime = Date.now();
            app.set('leaderboardLastReset', resetTime);
            //console.log('Auto-resetting leaderboard for new week...');

            const db = require('../utils/database');
            await new Promise((resolve, reject) => {
                db.run("UPDATE users SET songsPlayed = 0", function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });
            
            console.log('Leaderboard automatically reset for the new week!');
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error resetting leaderboard:', error);
        return false;
    }
}


router.get('/api/leaderboard/last-reset', (req, res) => {
    const lastReset = req.app.get('leaderboardLastReset') || Date.now();
    res.json({ lastReset });
});

router.get('/api/leaderboard', async (req, res) => {
    try {
        const db = require('../utils/database');
        const leaderboardData = await new Promise((resolve, reject) => {
            db.all("SELECT displayName, COALESCE(songsPlayed, 0) as songsPlayed FROM users WHERE id != 4 ORDER BY songsPlayed DESC", (err, rows) => {
                if (err) {
                    return reject(err);
                }
                resolve(rows);
            });
        });

        res.json({ ok: true, leaderboard: leaderboardData });
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

router.get('/api/leaderboard/update', async (req, res) => {
    try {
        const now = new Date();
        const lastReset = new Date(req.app.get('leaderboardLastReset') || 0);
        
        // Check if it's Monday (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
        const isMonday = now.getDay() === 1;
        
        // Check if we haven't reset yet this week
        // Calculate the start of this week (Monday)
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1)); // Get Monday
        startOfThisWeek.setHours(0, 0, 0, 0); // Set to start of day
        
        // Check if last reset was before this week's Monday
        const needsReset = lastReset < startOfThisWeek;
        
        if (isMonday && needsReset) {
            const resetTime = Date.now();
            req.app.set('leaderboardLastReset', resetTime);
            //console.log('Resetting leaderboard for new week...');

            const db = require('../utils/database');
            await new Promise((resolve, reject) => {
                db.run("UPDATE users SET songsPlayed = 0", function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });

            res.json({ ok: true, message: "Leaderboard has been reset for the new week." });
        } else {
            const nextMonday = new Date(startOfThisWeek);
            nextMonday.setDate(startOfThisWeek.getDate() + 7);
            res.json({ 
                ok: false, 
                message: "Leaderboard reset not needed at this time.",
                nextReset: nextMonday.toDateString()
            });
            // console.log('Leaderboard reset not needed. Next reset:', nextMonday.toDateString());
        }
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }

});

// Manual reset endpoint (for testing or admin use)
router.post('/api/leaderboard/force-reset', async (req, res) => {
    try {
        const resetTime = Date.now();
        req.app.set('leaderboardLastReset', resetTime);
        //console.log('🔄 Force resetting leaderboard...');

        const db = require('../utils/database');
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET songsPlayed = 0", function (err) {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });

        res.json({ ok: true, message: "Leaderboard has been force reset." });
        //console.log('Leaderboard force reset completed!');
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

// Auto-check endpoint (can be called by frontend or cron job)
router.get('/api/leaderboard/auto-check', async (req, res) => {
    const wasReset = await checkAndResetLeaderboard(req.app);
    if (wasReset) {
        res.json({ ok: true, message: "Leaderboard was reset for the new week." });
    } else {
        res.json({ ok: false, message: "No reset needed at this time." });
    }
});

module.exports = { router, checkAndResetLeaderboard };