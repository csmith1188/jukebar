// One-off script to seed fake student users + play-transaction history, for
// local testing of the Leaderboard / Teacher "Users" pages without needing
// real Formbar logins. Re-running is safe — it wipes and re-inserts just
// these fake rows each time. Run with:
//   node seed-fake-students.js
const db = require('./utils/database');

// Different play counts per student so the leaderboard actually looks
// ranked instead of all-tied.
const STUDENTS = [
    { id: 900001, displayName: 'Timmy', plays: 50 },
    { id: 900002, displayName: 'Bobby', plays: 40 },
    { id: 900003, displayName: 'Steven', plays: 30 },
    { id: 900004, displayName: 'John', plays: 20 },
    { id: 900005, displayName: 'Jacob', plays: 12 },
    { id: 900006, displayName: 'Jingleheimer', plays: 6 },
    { id: 900007, displayName: 'Schmit', plays: 1 },
    { id: 900008, displayName: 'Alice', plays: 58 },
    { id: 900009, displayName: 'Marcus', plays: 45 },
    { id: 900010, displayName: 'Priya', plays: 33 },
    { id: 900011, displayName: 'Diego', plays: 27 },
    { id: 900012, displayName: 'Chloe', plays: 52 },
    { id: 900013, displayName: 'Elijah', plays: 19 },
    { id: 900014, displayName: 'Fatima', plays: 41 },
    { id: 900015, displayName: 'Gavin', plays: 9 },
    { id: 900016, displayName: 'Hannah', plays: 37 },
    { id: 900017, displayName: 'Isaac', plays: 24 },
    { id: 900018, displayName: 'Jasmine', plays: 48 },
    { id: 900019, displayName: 'Kevin', plays: 14 },
    { id: 900020, displayName: 'Luna', plays: 31 },
    { id: 900021, displayName: 'Mason', plays: 5 },
    { id: 900022, displayName: 'Nadia', plays: 44 },
    { id: 900023, displayName: 'Oscar', plays: 22 },
    { id: 900024, displayName: 'Piper', plays: 39 },
    { id: 900025, displayName: 'Quinn', plays: 17 },
    { id: 900026, displayName: 'Isaiah', plays: 56 },
    { id: 900027, displayName: 'Sofia', plays: 28 },
    { id: 900028, displayName: 'Tyler', plays: 11 },
    { id: 900029, displayName: 'Uma', plays: 34 },
    { id: 900030, displayName: 'Victor', plays: 3 },
    { id: 900031, displayName: 'Willow', plays: 47 },
    { id: 900032, displayName: 'Xander', plays: 25 },
    { id: 900033, displayName: 'Yusuf', plays: 42 },
    { id: 900034, displayName: 'Zoe', plays: 8 },
    { id: 900035, displayName: 'Amara', plays: 30 },
    { id: 900036, displayName: 'Beckett', plays: 15 },
    { id: 900037, displayName: 'Camille', plays: 50 },
];

const FAKE_TRACKS = [
    { name: 'Bohemian Rhapsody', artist: 'Queen' },
    { name: "Don't Stop Believin'", artist: 'Journey' },
    { name: 'Mr. Brightside', artist: 'The Killers' },
    { name: 'Sweet Caroline', artist: 'Neil Diamond' },
    { name: 'Uptown Funk', artist: 'Mark Ronson ft. Bruno Mars' },
    { name: 'Blinding Lights', artist: 'The Weeknd' },
    { name: 'HUMBLE.', artist: 'Kendrick Lamar' },
    { name: 'Levitating', artist: 'Dua Lipa' },
];

const SONG_COST = Number(process.env.SONG_AMOUNT) || 50;

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function upsertUser(student) {
    await run(
        `INSERT INTO users (id, displayName, pin, songsPlayed, isBanned, permission)
         VALUES (?, ?, ?, ?, 0, 2)
         ON CONFLICT(id) DO UPDATE SET displayName = excluded.displayName, songsPlayed = excluded.songsPlayed`,
        [student.id, student.displayName, 1000 + student.id, student.plays]
    );
}

async function insertPlay(student, i) {
    const track = FAKE_TRACKS[i % FAKE_TRACKS.length];
    // Spread plays across the last 6 days so they land inside the
    // leaderboard's rolling 7-day window no matter when this is run.
    const hoursAgo = Math.random() * 6 * 24;
    const timestamp = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

    await run(
        `INSERT INTO transactions (user_id, display_name, action, track_uri, track_name, artist_name, image_url, cost, timestamp)
         VALUES (?, ?, 'play', ?, ?, ?, NULL, ?, ?)`,
        [student.id, student.displayName, `spotify:track:fake${student.id}${i}`, track.name, track.artist, SONG_COST, timestamp]
    );
}

async function seed() {
    const ids = STUDENTS.map((s) => s.id).join(',');
    // Clear out any previous run's rows for these fake students first, so
    // re-running this script doesn't keep stacking up duplicate plays.
    await run(`DELETE FROM transactions WHERE user_id IN (${ids})`);

    for (const student of STUDENTS) {
        await upsertUser(student);
        for (let i = 0; i < student.plays; i++) {
            await insertPlay(student, i);
        }
        console.log(`Seeded ${student.displayName} (id ${student.id}): ${student.plays} plays`);
    }
}

seed()
    .then(() => {
        console.log('Done seeding fake students.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Error seeding fake students:', err);
        process.exit(1);
    });
