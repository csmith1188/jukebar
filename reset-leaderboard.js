const db = require('./utils/database');

async function resetLeaderboard() {
    try {
        console.log('Resetting leaderboard...');
        
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET songsPlayed = 0", function (err) {
                if (err) {
                    return reject(err);
                }
                console.log(`Reset ${this.changes} user records`);
                resolve();
            });
        });
        
        console.log('Leaderboard reset complete!');
        process.exit(0);
    } catch (error) {
        console.error('Error resetting leaderboard:', error);
        process.exit(1);
    }
}

resetLeaderboard();