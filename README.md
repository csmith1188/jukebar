# Jukebar

Jukebar is a Node.js classroom jukebox that integrates with Spotify and Formbar. Users pay with Digipogs to queue songs, skip tracks, buy skip shields, start community ban votes, and manage custom playlists.

## Features

- **Spotify playback and queue control**
- **Formbar OAuth login** with session-based auth
- **Digipog payment flow** for songs, skips, shields, ban-vote starts, and playlist actions
- **Skip Shield system** (buy shields to protect a song; blocked skips consume one shield)
- **Anonymous mode** (queue songs without leaderboard credit)
- **Track ban system**
    - Teacher/owner direct bans with required reason
    - Community ban voting (minimum 5 users online required)
- **Teacher Playlist Allowlist** — teachers allow/disallow Spotify playlists for student queue purchases; cost is computed from playlist size
- **Custom Playlists** — students create personal Spotify playlists, add/remove songs, and pay to play them
- **User moderation** (ban/unban users, teacher transaction views)
- **Leaderboard** with automatic weekly reset
- **Real-time updates** with Socket.IO
- **Recently queued history** per user with album art
- **JukePix integration**
    - Toggle bridge on/off
    - Global/default visual settings
    - Per-artist and per-song overrides
    - Configurable skip/shield sound selection
- **Spotify diagnostics** endpoint for teachers
- **SQLite persistence** for users, queue metadata, bans, transactions, and playlists
- **In-app changelog** loaded from `changelog.json`

## Architecture

- **Server:** Express (`app.js` + `routes/`) — REST API, Socket.IO, Formbar OAuth/session auth, Spotify integration, SQLite persistence.
- **Front end:** React + Vite + antd, in `client/`, built to `client/dist` and served by Express at `/app/*`. No server-rendered HTML/EJS remains; the server only hands the SPA JSON (`/api/me`, `/api/queue`, etc.) and the SPA renders everything client-side.

| React page (`client/src/pages/`) | Route | Purpose |
|---|---|---|
| `PlayerPage.jsx` | `/app/player` | Search, queue, now playing, playlists sidebar |
| `TeacherPage.jsx` | `/app/teacher` | User/ban moderation, playlist allowlist, transactions |
| `SettingsPage.jsx` | `/app/settings` | JukePix defaults/overrides |
| `LeaderboardPage.jsx` | `/app/leaderboard` | Weekly song leaderboard |

## Prerequisites

- Node.js 18+
- Spotify Premium account and Spotify app credentials (Development Mode or Extended Quota Mode)
- Formbar instance access and API key
- Active Spotify playback device
- Optional: `omxplayer` (Raspberry Pi — plays blocked-skip SFX)

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd jukebar
```

2. Install dependencies and initialize the database:

```bash
npm run build
```

(`build` runs `npm install` then `npm run migrate`.)

3. Install and build the React front end (served at `/app/*`):

```bash
npm run client:install
npm run client:build
```

(`client:install` runs `npm install` inside `client/`; `client:build` runs `vite build`, producing `client/dist`. Re-run `client:build` any time you pull changes to `client/src`. Without a build, `/app/*` returns a 503 telling you to build it.)

4. Create a `.env` file from `.env-template` and fill in all values (see [Environment Variables](#environment-variables) below).

5. Set up Spotify credentials — see [`setup.md`](docs/setup.md) for a step-by-step guide. Use `spotify.js` to generate your refresh token:

```bash
node spotify.js
```

6. Start the app:

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

For front-end development with hot reload, keep the Express server running and, in a second terminal, run the Vite dev server:

```bash
npm run client:dev
```

Vite proxies `/api`, `/socket.io`, `/login`, `/logout`, `/img`, and `/styles.css` to the Express server (see `client/vite.config.js`), so open `http://localhost:5173/app/player` instead of `:5000` while iterating on `client/src`.

7. Open in browser:

`http://localhost:5000`

## Deploy on Render

1. Connect this repo as a **Web Service** (Node).
2. **Build Command:** `npm run build`
3. **Start Command:** `npm start`
4. Set environment variables from `.env-template`. Important:
   - `URL` = your public Render URL (e.g. `https://jukebar.onrender.com`) — do **not** append Render’s internal `PORT`
   - `FORMBAR_ADDRESS` = your Formbar base URL (no trailing slash)
   - `DATABASE_PATH=/var/data/database.db` if you attach a persistent disk at `/var/data`
5. Optional: use the included `render.yaml` Blueprint.

Render sets `PORT` and `NODE_ENV=production` for you. The app binds to `0.0.0.0` and trusts the proxy so sessions and Formbar OAuth redirects work.

> **Note:** For more information on hosting locally, go to [Guide](docs/setup.md)

## Pages

The front end is a React SPA (`client/`, built with Vite) served by Express at `/app/*`. There is no server-rendered HTML beyond that shell — EJS templates have been removed entirely.

| Route | Description | Access |
|---|---|---|
| `/app/player` | Main jukebox player | Authenticated users |
| `/app/leaderboard` | Song leaderboard | Authenticated users |
| `/app/teacher` | Teacher control panel | Permission ≥ 4 or owner |
| `/app/settings` | JukePix settings (linked from the Teacher page's gear icon) | Permission ≥ 4 or owner |

Old pre-React paths still work and just redirect into the SPA, so existing bookmarks/links don't break:

| Old path | Redirects to |
|---|---|
| `/` | `/app/player` |
| `/player` | `/app/player` |
| `/spotify` | `/app/player` |
| `/settings` | `/app/settings` |
| `/leaderboard` | `/app/leaderboard` |
| `/teacher` | `/app/teacher` (or `/` if not a teacher/owner) |

## Environment Variables

Use `.env-template` as the source of truth. Key variables:

```env
# Server / Render
NODE_ENV=production
URL=https://your-service.onrender.com
DATABASE_PATH=/var/data/database.db

# Formbar
FORMBAR_ADDRESS=https://formbar.yorktechapps.com
FORMBAR_SESSION_SECRET=...
API_KEY=your_formbar_api_key
POOL_ID=your_pool_id
OWNER_ID=comma_separated_owner_ids
OWNER_PIN=first_owner_pin

# Spotify
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
SPOTIFY_SCOPES=user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-read-private
# Optional polling / backoff (defaults shown; omit to use them)
# SPOTIFY_BACKGROUND_API=true
# SPOTIFY_DEEP_IDLE_AFTER_MS=1800000
# SPOTIFY_DEEP_IDLE_POLL_GAP_MS=300000
# SPOTIFY_MAX_BACKOFF_MS=900000
# SPOTIFY_BROKEY_MIN_COOLDOWN_MS=60000

# Pricing
SONG_AMOUNT=50
SKIP_AMOUNT=100
SKIP_SHIELD_AMOUNT=75
VOTE_BAN_AMOUNT=500
CREATE_PLAYLIST_AMOUNT=700
ADD_PLAYLIST_SONG_AMOUNT=100
REMOVE_PLAYLIST_SONG_AMOUNT=50
CUSTOM_PLAYLIST_PLAY_AMOUNT=250

# JukePix
JUKEPIX_ENABLED=false
JUKEPIX_URL=http://localhost:421
JUKEPIX_API_KEY=...
JUKEPIX_LENGTH=100
```

## Default Pricing

| Action | Default Cost |
|---|---|
| Queue a song | **50** |
| Skip a song | **100** |
| Buy a skip shield | **75** |
| Start a ban vote | **500** |
| Create a custom playlist | **700** |
| Add a song to custom playlist | **100** |
| Remove a song from custom playlist | **50** |
| Play a custom playlist | **250** |
| Play an allowed playlist | Computed from track count |

All values are environment-driven and can be changed in `.env`.

## API Endpoints

### Auth

- `GET /login`
- `GET /logout`

### Spotify and Queue

- `POST /search` — search Spotify tracks
- `GET /getQueue` — get current Spotify queue
- `POST /addToQueue` — queue a track (payment required for non-owners)
- `GET /currentlyPlaying` — get currently playing track
- `POST /skip` — skip current track (payment required for non-owners)
- `POST /purchaseShield` — add skip shields to a queued track
- `POST /checkTrackExists` — check if a track is in the queue or playing
- `GET /recentlyQueued` — get the current user's recently queued tracks
- `POST /clearQueueHistory` — clear the current user's queue history
- `GET /queue/state` — get internal queue state
- `POST /queue/add` — add track to internal queue
- `POST /queue/skip` — skip current track (teacher/owner only)
- `GET /api/currentTrack` — get currently playing track (raw)

### Spotify Playlist Allowlist (Teacher)

- `GET /api/spotify/playlists` — list all Spotify playlists with allowlist state
- `POST /api/spotify/playlists/allow` — allow a playlist for student use
- `POST /api/spotify/playlists/disallow` — disallow a playlist
- `GET /api/playlists/allowed` — get allowed playlists for the current class
- `POST /api/playlists/quote` — get cost quote for queuing an allowed playlist
- `POST /api/playlists/queue` — start playback from an allowed playlist

### Custom Playlists

- `GET /api/custom-playlists` — list custom playlists for the current class
- `POST /api/custom-playlists/create` — create a new custom playlist (up to 5 initial songs free)
- `GET /api/custom-playlists/:id/tracks` — get tracks in a custom playlist
- `POST /api/custom-playlists/add-song` — add a song to a custom playlist
- `POST /api/custom-playlists/remove-song` — remove a song from a custom playlist
- `POST /api/custom-playlists/queue` — start playback from a custom playlist

### Track Bans

- `POST /banTrack` — ban a track by name/artist (teacher/owner; reason required)
- `POST /unbanTrack` — unban a track (teacher/owner)

### Payments

- `POST /transfer`
- `POST /refund`
- `POST /savePin`
- `POST /getPin`
- `POST /claimPayment`
- `GET /paymentStatus`
- `POST /getAmount`
- `POST /testPayment` (non-production only)

### Users and Teacher Tools

- `GET /api/users` — list all users (teacher)
- `POST /api/users/ban` — ban a user (teacher; cannot ban other teachers or owners)
- `POST /api/users/unban` — unban a user (teacher)
- `GET /api/users/banned` — list banned users (teacher)
- `GET /api/me/banned` — check if current user is banned
- `GET /api/queueHistory` — paginated play history with album art (teacher)
- `POST /api/users/transactions` — get transaction history for a user (teacher)
- `GET /api/banned-songs` — list banned songs (teacher)

### Leaderboard

- `GET /api/leaderboard` — songs played per user over the last 7 days (weekly window, not a stored/reset counter)

### React Front End

- `GET /api/me` — session/config JSON for the React SPA (permissions, pricing, owner IDs, changelog, feature flags, etc.) — the React equivalent of what the old EJS templates got as server-rendered locals
- `GET /api/queue` — current queue/now-playing state, for prefetching on SPA boot (same shape as the `requestQueueUpdate` Socket.IO event)

### JukePix and Settings

- `POST /toggleJukepix`
- `GET /jukepixStatus`
- `GET /api/settings/defaults`
- `PUT /api/settings/defaults`
- `POST /api/settings/defaults/reset`
- `GET /api/settings/overrides`
- `POST /api/settings/overrides`
- `PUT /api/settings/overrides/:id`
- `DELETE /api/settings/overrides/:id`
- `GET /api/settings/resolve`
- `GET /api/settings/sounds`

### Diagnostics and Utilities

- `GET /diagnostics` — Spotify API health check (teacher/owner)
- `GET /api/online-count` — number of connected clients
- `GET /debug/formbar` — Formbar socket connection status (authenticated)

## Database Tables

| Table | Purpose |
|---|---|
| `users` | User accounts, ban status, permission level |
| `transactions` | All Digipog transactions (plays, skips, shields, bans, playlists) |
| `banned_songs` | Track ban list with reason and who banned it |
| `queue_metadata` | Track attribution, timestamps, anon mode, shield count |
| `currently_playing` | Metadata for the currently playing track |
| `track_bans` | Lightweight vote-ban tracking by URI |
| `allowed_playlists` | Teacher-allowed Spotify playlists per class |
| `custom_playlists` | Student-created custom playlists (linked to Spotify) |
| `jukepix_settings` | Per-artist/per-song JukePix overrides |
| `jukepix_defaults` | Global JukePix visual defaults |

## Notes

- Session and token checks gate all protected routes.
- Teacher actions require permission level `>= 4` or owner status.
- Owners bypass payment checks and receive free actions.
- Queue and moderation events are synchronized in real time via Socket.IO.
- Ban votes require at least **5 users online** to start.
- Playlists and custom playlists are scoped to the current Formbar class ID.
- Spotify's Development Mode limits apps to **10 users**. Apply for Extended Quota Mode to remove this limit.
- Background Spotify polling (queue sync + diagnostics) backs off when playback/queue is unchanged — 8s while active, 120s after ~10 stable cycles, then 5 minutes after 30 minutes of silence — even if a browser tab stays connected. Repeated 429s escalate exponentially up to 15 minutes (`SPOTIFY_MAX_BACKOFF_MS`). Teachers can still kill background polling from the Teacher page.
- The `spotify.js` script generates a Spotify refresh token. Credentials are loaded from `.env` — never hardcode them.
- The batch `GET /tracks` Spotify endpoint was removed for Development Mode apps in February 2026. Track lookups use individual `GET /tracks/{id}` calls.

## Contributing

Contributions are welcome.

## License

Educational project in the York Tech Apps Environment.
