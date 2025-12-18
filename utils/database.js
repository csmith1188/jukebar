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

// Check if table needs migration (remove PRIMARY KEY constraint)
db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_metadata'", [], (err, row) => {
    if (err) {
        console.error('Error checking queue_metadata schema:', err);
        return;
    }
    
    // If table exists and has PRIMARY KEY, recreate it
    if (row && row.sql.includes('PRIMARY KEY')) {
        console.log('Migrating queue_metadata table to remove UNIQUE constraint...');
        
        db.serialize(() => {
            // Rename old table
            db.run('ALTER TABLE queue_metadata RENAME TO queue_metadata_old', (renameErr) => {
                if (renameErr) {
                    console.error('Error renaming table:', renameErr);
                    return;
                }
                
                // Create new table without PRIMARY KEY
                db.run(`CREATE TABLE queue_metadata (
                    track_uri TEXT NOT NULL,
                    added_by TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    display_name TEXT NOT NULL,
                    is_anon INTEGER DEFAULT 0,
                    skip_shields INTEGER DEFAULT 0
                )`, (createErr) => {
                    if (createErr) {
                        console.error('Error creating new table:', createErr);
                        return;
                    }
                    
                    // Copy data from old table
                    db.run(`INSERT INTO queue_metadata SELECT * FROM queue_metadata_old`, (copyErr) => {
                        if (copyErr) {
                            console.error('Error copying data:', copyErr);
                            return;
                        }
                        
                        // Drop old table
                        db.run('DROP TABLE queue_metadata_old', (dropErr) => {
                            if (dropErr) {
                                console.error('Error dropping old table:', dropErr);
                            } else {
                                console.log('Successfully migrated queue_metadata table (duplicates now allowed)');
                            }
                        });
                    });
                });
            });
        });
    } else if (!row) {
        // Table doesn't exist, create it fresh
        db.run(`CREATE TABLE queue_metadata (
            track_uri TEXT NOT NULL,
            added_by TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            is_anon INTEGER DEFAULT 0,
            skip_shields INTEGER DEFAULT 0
        )`, (createErr) => {
            if (createErr) {
                console.error('Error creating queue_metadata table:', createErr);
            } else {
                console.log('queue_metadata table created');
            }
        });
    } else {
        console.log('queue_metadata table ready');
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

db.run(`CREATE TABLE IF NOT EXISTS track_bans (
    track_uri TEXT PRIMARY KEY,
    banned_at INTEGER NOT NULL
)`);

module.exports = db;
