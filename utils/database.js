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

// Create all tables immediately (not in serialize to avoid blocking exports)
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    displayName TEXT,
    pin INTEGER,
    songsPlayed INTEGER DEFAULT 0
);`);

// Migrate: add isBanned column if it doesn't exist
db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
        console.error('Error checking users schema:', err);
        return;
    }
    const hasIsBanned = columns && columns.some(c => c.name === 'isBanned');
    if (!hasIsBanned) {
        db.run("ALTER TABLE users ADD COLUMN isBanned INTEGER DEFAULT 0", (alterErr) => {
            if (alterErr) {
                console.error('Error adding isBanned column:', alterErr);
            } else {
                console.log('Added isBanned column to users table');
            }
        });
    }
    const hasPermission = columns && columns.some(c => c.name === 'permission');
    if (!hasPermission) {
        db.run("ALTER TABLE users ADD COLUMN permission INTEGER DEFAULT 2", (alterErr) => {
            if (alterErr) {
                console.error('Error adding permission column:', alterErr);
            } else {
                console.log('Added permission column to users table');
            }
        });
    }
});

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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_name TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    track_uri TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    banned_by TEXT NOT NULL DEFAULT 'unknown',
    reason TEXT DEFAULT 'No reason given'
)`);

// Migrate: ensure banned_songs has all required columns
db.all("PRAGMA table_info(banned_songs)", (err, columns) => {
    if (err) {
        console.error('Error checking banned_songs schema:', err);
        return;
    }

    const hasColumn = (name) => columns && columns.some(c => c.name === name);
    const migrations = [];

    if (!hasColumn('track_name')) {
        migrations.push("ALTER TABLE banned_songs ADD COLUMN track_name TEXT");
    }
    if (!hasColumn('artist_name')) {
        migrations.push("ALTER TABLE banned_songs ADD COLUMN artist_name TEXT");
    }
    if (!hasColumn('track_uri')) {
        migrations.push("ALTER TABLE banned_songs ADD COLUMN track_uri TEXT");
    }
    if (!hasColumn('timestamp')) {
        migrations.push("ALTER TABLE banned_songs ADD COLUMN timestamp DATETIME DEFAULT CURRENT_TIMESTAMP");
    }
    if (!hasColumn('banned_by')) {
        migrations.push("ALTER TABLE banned_songs ADD COLUMN banned_by TEXT DEFAULT 'unknown'");
    }
    if (!hasColumn('reason')) {
        migrations.push("ALTER TABLE banned_songs ADD COLUMN reason TEXT DEFAULT 'No reason given'");
    }

    if (migrations.length === 0) {
        return;
    }

    db.serialize(() => {
        migrations.forEach((sql) => {
            db.run(sql, (migrationErr) => {
                if (migrationErr) {
                    console.error('Error migrating banned_songs table:', migrationErr);
                } else {
                    console.log(`Applied migration: ${sql}`);
                }
            });
        });
    });
});

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

db.run(`CREATE TABLE IF NOT EXISTS allowed_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spotify_playlist_id TEXT NOT NULL,
    name TEXT,
    owner_name TEXT,
    image_url TEXT,
    total_tracks INTEGER DEFAULT 0,
    is_allowed INTEGER DEFAULT 0,
    updated_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    class_id INTEGER,
    UNIQUE(spotify_playlist_id, class_id)
)`);

// Migrate: recreate allowed_playlists with composite unique key if old schema detected
db.all("PRAGMA index_list(allowed_playlists)", (err, indexes) => {
    if (err) return;
    // Check if there's a unique index on spotify_playlist_id alone (old schema)
    // We detect by trying to find a unique index that doesn't include class_id
    let needsMigration = false;
    let checksRemaining = indexes ? indexes.length : 0;
    if (checksRemaining === 0) return;

    indexes.forEach(idx => {
        if (!idx.unique) {
            checksRemaining--;
            if (checksRemaining === 0 && needsMigration) runMigration();
            return;
        }
        db.all(`PRAGMA index_info('${idx.name}')`, (err, cols) => {
            if (!err && cols.length === 1 && cols[0].name === 'spotify_playlist_id') {
                needsMigration = true;
            }
            checksRemaining--;
            if (checksRemaining === 0 && needsMigration) runMigration();
        });
    });

    function runMigration() {
        console.log('Detected old allowed_playlists schema, migrating to composite unique key...');
        db.serialize(() => {
            db.run("ALTER TABLE allowed_playlists RENAME TO allowed_playlists_old");
            db.run(`CREATE TABLE allowed_playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                spotify_playlist_id TEXT NOT NULL,
                name TEXT,
                owner_name TEXT,
                image_url TEXT,
                total_tracks INTEGER DEFAULT 0,
                is_allowed INTEGER DEFAULT 0,
                updated_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                class_id INTEGER,
                UNIQUE(spotify_playlist_id, class_id)
            )`);
            // Copy data; old rows get class_id = NULL from old table
            const oldCols = 'id, spotify_playlist_id, name, owner_name, image_url, total_tracks, is_allowed, updated_by, created_at, updated_at';
            db.all("PRAGMA table_info(allowed_playlists_old)", (err, columns) => {
                const hasClassId = columns && columns.some(c => c.name === 'class_id');
                const selectCols = hasClassId ? oldCols + ', class_id' : oldCols;
                const insertCols = hasClassId ? oldCols + ', class_id' : oldCols;
                db.run(`INSERT INTO allowed_playlists (${insertCols}) SELECT ${selectCols} FROM allowed_playlists_old`);
                db.run("DROP TABLE allowed_playlists_old", (err) => {
                    if (err) console.error('Error migrating allowed_playlists:', err.message);
                    else console.log('Migrated allowed_playlists to composite unique key with class_id');
                });
            });
        });
    }
});

// Clean up duplicate allowed_playlists rows with NULL class_id (caused by old bug)
db.run(`DELETE FROM allowed_playlists WHERE id NOT IN (
    SELECT MIN(id) FROM allowed_playlists GROUP BY spotify_playlist_id, COALESCE(class_id, '__NULL__')
)`, function (err) {
    if (err) console.error('Error cleaning up duplicate allowed_playlists:', err.message);
    else if (this.changes) console.log(`Cleaned up ${this.changes} duplicate allowed_playlists row(s)`);
});

db.run(`CREATE TABLE IF NOT EXISTS custom_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    class_id INTEGER,
    spotify_playlist_id TEXT NOT NULL,
    name TEXT NOT NULL,
    song_count INTEGER DEFAULT 0,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
)`);

// Migrate: add class_id to custom_playlists if it doesn't exist
db.all("PRAGMA table_info(custom_playlists)", (err, columns) => {
    if (!err && columns && !columns.some(c => c.name === 'class_id')) {
        db.run("ALTER TABLE custom_playlists ADD COLUMN class_id INTEGER", (alterErr) => {
            if (alterErr) console.error('Error adding class_id to custom_playlists:', alterErr);
            else console.log('Added class_id column to custom_playlists table');
        });
    }

    if (!err && columns && !columns.some(c => c.name === 'image_url')) {
        db.run("ALTER TABLE custom_playlists ADD COLUMN image_url TEXT", (alterErr) => {
            if (alterErr) console.error('Error adding image_url to custom_playlists:', alterErr);
            else console.log('Added image_url column to custom_playlists table');
        });
    }
});

// JukePix custom settings per artist/song
db.run(`CREATE TABLE IF NOT EXISTS jukepix_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type TEXT NOT NULL CHECK(match_type IN ('artist', 'song')),
    match_value TEXT NOT NULL,
    match_artist TEXT,
    text_color TEXT DEFAULT '#ffffff',
    progress_fg1 TEXT DEFAULT '#00ff00',
    progress_fg2 TEXT DEFAULT '#29ff29',
    skip_sound TEXT,
    shield_sound TEXT,
    scroll_speed INTEGER DEFAULT 50,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_type, match_value, match_artist)
)`);

// JukePix global/default settings
db.run(`CREATE TABLE IF NOT EXISTS jukepix_defaults (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    text_color TEXT DEFAULT '#ffffff',
    bg_color TEXT DEFAULT '#000000',
    progress_fg1 TEXT DEFAULT '#00ff00',
    progress_fg2 TEXT DEFAULT '#29ff29',
    gradient_start TEXT DEFAULT '#1ed760',
    gradient_end TEXT DEFAULT '#0c4d22',
    scroll_speed INTEGER DEFAULT 50,
    skip_sound TEXT,
    shield_sound TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Insert default row if it doesn't exist
db.run(`INSERT OR IGNORE INTO jukepix_defaults (id) VALUES (1)`);

module.exports = db;
