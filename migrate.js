/**
 * Ensures the SQLite database directory and schema exist.
 * Safe to run at build/deploy time and again on every start.
 *
 * Uses DATABASE_PATH (default: db/database.db).
 * On Render with a persistent disk, set e.g. DATABASE_PATH=/var/data/database.db
 */
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join('db', 'database.db');
const dbFolder = path.dirname(dbPath);

if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
    console.log(`Created database directory: ${dbFolder}`);
}

process.env.DATABASE_PATH = dbPath;

// Loading database.js creates/migrates all tables.
const db = require('./utils/database');

function closeAndExit(code) {
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
            process.exit(1);
        }
        console.log(`Migration complete: ${dbPath}`);
        process.exit(code);
    });
}

// Give async PRAGMA/ALTER migrations a moment to finish, then verify connectivity.
db.get('SELECT 1 AS ok', (err, row) => {
    if (err) {
        console.error('Database migration failed:', err.message);
        return closeAndExit(1);
    }

    if (!row || row.ok !== 1) {
        console.error('Database migration failed: unexpected probe result');
        return closeAndExit(1);
    }

    // Brief delay so fire-and-forget ALTER TABLE migrations can apply.
    setTimeout(() => closeAndExit(0), 1500);
});
