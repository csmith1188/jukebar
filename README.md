# Jukebar

Jukebar is a Node.js classroom jukebox that integrates with Spotify and Formbar. Users can pay with Digipogs to queue songs, skip tracks, buy shields, and initiate ban votes.

## Features

- **Spotify playback and queue control**
- **Formbar OAuth login** with session-based auth
- **Digipog payment flow** for songs, skips, shields, and ban-vote starts
- **Skip Shield system** (buy shields, consume on blocked skip)
- **Anonymous mode** (queue songs without leaderboard credit)
- **Track ban system**
    - Teacher/owner direct bans
    - Community ban voting with online-user minimum
- **User moderation** (ban/unban users, teacher transaction views)
- **Leaderboard** with automatic weekly reset
- **Real-time updates** with Socket.IO
- **JukePix integration**
    - Toggle bridge on/off
    - Global/default visual settings
    - Per-artist and per-song overrides
    - Configurable skip/shield sound selection
- **SQLite persistence** for users, queue metadata, bans, and transactions

## Prerequisites

- Node.js 18+ (recommended)
- Spotify Premium account and Spotify app credentials
- Formbar instance access and API key
- Active Spotify playback device
- Optional: `omxplayer` (Raspberry Pi blocked-skip SFX)

## Installation

1. Clone repository:

```bash
git clone <repository-url>
cd Jukebar
```

2. Install dependencies:

```bash
npm install
```

3. Create `.env` from `.env-template` and fill values.

4. Start app:

```bash
node app.js
```

5. Open browser:

`http://localhost:5000`

## Environment Variables

Use `.env-template` as the source of truth. Common keys:

```env
# Formbar
FORMBAR_ADDRESS=http://localhost:420
API_KEY=your_formbar_api_key
URL=http://localhost
POOL_ID=your_pool_id
OWNER_ID=comma_separated_owner_ids
OWNER_PIN=first_owner_pin

# Spotify
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...

# Pricing
SONG_AMOUNT=50
SKIP_AMOUNT=100
SKIP_SHIELD_AMOUNT=75
VOTE_BAN_AMOUNT=500

# Optional compatibility keys used in some paths
SKIP_SHIELD=75
TRANSFER_AMOUNT=50

# JukePix
JUKEPIX_URL=http://localhost:421
JUKEPIX_API_KEY=...
JUKEPIX_LENGTH=100
```

## Default Pricing

- Song: **50**
- Skip: **100**
- Skip Shield: **75**
- Ban Vote Start: **500**

Actual values are environment-driven.

## Main Endpoints

### Auth

- `GET /login`
- `GET /logout`

### Spotify and Queue

- `POST /search`
- `GET /getQueue`
- `POST /addToQueue`
- `GET /currentlyPlaying`
- `POST /skip`
- `POST /purchaseShield`
- `POST /checkTrackExists`
- `GET /queue/state`
- `POST /queue/add`
- `POST /queue/skip`
- `GET /api/currentTrack`

### Bans

- `POST /banTrack` (teacher/owner)
- `POST /unbanTrack` (teacher/owner)

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

- `GET /api/users`
- `POST /api/users/ban`
- `POST /api/users/unban`
- `GET /api/users/banned`
- `GET /api/me/banned`
- `GET /api/queueHistory`
- `POST /api/users/transactions`
- `POST /api/users/transactions/modal`
- `GET /api/banned-songs`

### Leaderboard

- `GET /api/leaderboard`
- `GET /api/leaderboard/last-reset`
- `GET /api/leaderboard/update`
- `GET /api/leaderboard/auto-check`
- `POST /api/leaderboard/force-reset`

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

## Database Tables

- `users`
- `transactions`
- `banned_songs`
- `queue_metadata`
- `currently_playing`
- `track_bans`
- `jukepix_settings`
- `jukepix_defaults`

## Notes

- Session + token checks gate protected routes.
- Teacher actions require permission level `>= 4` or owner status.
- Owners bypass some payment checks.
- Queue and moderation events are synchronized in real time with Socket.IO.

## Contributing

Contributions are welcome.

## License

Educational project in the York Tech Apps ecosystem.