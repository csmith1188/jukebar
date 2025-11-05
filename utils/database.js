const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const folderPath = 'db';

const db = new sqlite3.Database('db/database.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
        if (err.code === 'SQLITE_CANTOPEN') {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`Created folder: ${folderPath}`);
            const db = new sqlite3.Database('db/database.db');
            return db;
        }
    } else {
        console.log("Connected to database");
    }
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    displayName TEXT,
    pin INTEGER,
    songsPlayed INTEGER DEFAULT 0
);`);

db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    action TEXT NOT NULL,
    track_uri TEXT,
    track_name TEXT,
    artist_name TEXT,
    cost INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
)`);


module.exports = db;
