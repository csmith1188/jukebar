const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const folderPath = 'db';

const db = new sqlite3.Database('db/database.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
        if (err.code === 'SQLITE_CANTOPEN') {
            fs.mkdirSync(folderPath, { recursive: true });
            //console.log(`Created folder: ${folderPath}`);
            const db = new sqlite3.Database('db/database.db');
            return db;
        }
    } else {
        //console.log("Connected to database");
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

db.run(`CREATE TABLE IF NOT EXISTS banned_songs (
    id INTEGER PRIMARY KEY,
    track_name TEXT,
    artist_name TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS queue_metadata (
    track_uri TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    display_name TEXT NOT NULL
)`, (err) => {
    if (err) {
        console.error('Error creating queue_metadata table:', err);
    } else {

        // Clear the queue metadata on app startup
        db.run('DELETE FROM queue_metadata', (clearErr) => {
            if (clearErr) {
                console.error('Error clearing queue_metadata on startup:', clearErr);
            } else {
                console.log('Cleared queue_metadata on app startup');
            }
        });
    }
});

module.exports = db;
