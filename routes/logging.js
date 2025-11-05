const db = require("../utils/database");

async function logTransaction({ userID, displayName, action, trackURI = null, trackName = null, artistName = null, cost }) {
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO transactions (user_id, display_name, action, track_uri, track_name, artist_name, cost) 
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [userID, displayName, action, trackURI, trackName, artistName, cost];
        db.run(query, params, function (err) {
            if (err) {
                console.error('Error logging transaction:', err);
                return reject(err);
            }
            resolve(this.lastID);
        });
    });
}

async function getTransactionsByUser(userID) {
    return new Promise((resolve, reject) => {
        const query = `SELECT * FROM transactions WHERE user_id = ? ORDER BY timestamp DESC`;
        db.all(query, [userID], (err, rows) => {
            if (err) {
                console.error('Error fetching transactions:', err);
                return reject(err);
            }
            resolve(rows);
        });
    });
}

module.exports = { logTransaction, getTransactionsByUser };