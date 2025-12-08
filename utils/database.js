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
    display_name TEXT NOT NULL,
    skip_shields INTEGER DEFAULT 0
)`, (err) => {
    if (err) {
        console.error('Error creating queue_metadata table:', err);
    } else {
        // Add is_anon column if it doesn't exist
                db.run(`ALTER TABLE queue_metadata ADD COLUMN is_anon INTEGER DEFAULT 0`, (alterErr) => {
            if (alterErr) {
                if (!alterErr.message.includes('duplicate column')) {
                    console.error('Error adding is_anon column:', alterErr);
                }
            } else {
                console.log('Added is_anon column to queue_metadata table');
            }
            
            // ADD THIS: Migrate skip_shields column
            db.run(`ALTER TABLE queue_metadata ADD COLUMN skip_shields INTEGER DEFAULT 0`, (shieldErr) => {
                if (shieldErr) {
                    if (!shieldErr.message.includes('duplicate column')) {
                        console.error('Error adding skip_shields column:', shieldErr);
                    }
                } else {
                    console.log('Added skip_shields column to queue_metadata table');
                }
                
                // DO NOT clear queue metadata on startup - we want to preserve it
                // for pre-existing Spotify queue tracks and skip shields
                console.log('queue_metadata table ready');
            });
        });
    }
});

db.run(`CREATE TABLE IF NOT EXISTS currently_playing (
    track_uri TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    skip_shields INTEGER DEFAULT 0,
    is_anon INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0
    )`);

module.exports = db;
