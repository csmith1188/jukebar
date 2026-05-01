// Reset the leaderboard counters for all users in the database.
const db = require('./utils/database');

async function resetLeaderboard() {
    try {
        //console.log('Resetting leaderboard...');
        
        await new Promise((resolve, reject) => {
            // Set songsPlayed back to zero for every user record.
            db.run("UPDATE users SET songsPlayed = 0", function (err) {
                if (err) {
                    return reject(err);
                }
                //console.log(`Reset ${this.changes} user records`);
                resolve();
            });
        });
        
        //console.log('Leaderboard reset complete!');
        // Exit with success status after the reset finishes.
        process.exit(0);
    } catch (error) {
        console.error('Error resetting leaderboard:', error);
        // Exit with failure status if the reset fails.
        process.exit(1);
    }
}

resetLeaderboard();