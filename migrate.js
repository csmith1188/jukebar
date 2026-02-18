const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('db/database.db');

db.serialize(() => {
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
    )`, (err) => {
        if (err) console.error('jukepix_settings:', err.message);
        else console.log('jukepix_settings OK');
    });

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
    )`, (err) => {
        if (err) console.error('jukepix_defaults:', err.message);
        else console.log('jukepix_defaults OK');
    });

    db.run(`INSERT OR IGNORE INTO jukepix_defaults (id) VALUES (1)`, (err) => {
        if (err) console.error('insert defaults:', err.message);
        else console.log('default row OK');
        db.close(() => console.log('Migration complete.'));
    });
});
