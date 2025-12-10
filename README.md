# Jukebar

Jukebar is a Node.js jukebox application that integrates with Spotify and Formbar, allowing users to search for and play music by making payments with their Digipogs.

## Features

- **Spotify Integration**: Search and play music directly from Spotify
- **Authentication**: Secure login system with JWT tokens from Formbar accounts
- **Payment System**: Integrated with Formbar Digipogs for song purchases and skip shields
- **Skip Shield System**: Purchase shields (25 Digipogs) to protect your songs from being skipped (100 Digipogs cost)
- **Anonymous Mode**: Add songs anonymously without tracking to your play count
- **Queue Management**: Real-time queue synchronization with shield protection display
- **Skip Protection Sound Effects**: Random audio feedback when shields block skip attempts (Raspberry Pi compatible)
- **Real-time Updates**: WebSocket-based live updates for queue, playback state, and currently playing
- **User Management**: SQLite database for user data, PIN storage, and queue metadata
- **Leaderboard**: Track top contributors based on songs played
- **Transaction Logging**: Complete audit trail of all Digipog transactions
- **Session Management**: Secure session handling with Express

## Prerequisites

Before running this application, ensure you have:

- Node.js (version 14 or higher)
- A Spotify Premium account
- Spotify application registered with Spotify for Developers
- Access to Formbar API for payment processing
- A device with Spotify open and active for playback
- **Optional**: omxplayer installed (for Raspberry Pi audio playback of shield block sound effects)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd Jukebar
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REFRESH_TOKEN=your_spotify_refresh_token
FORMBAR_ADDRESS=https://your-formbar-instance.com
PUBLIC_KEY=your_formbar_public_key
API_KEY=your_formbar_api_key
```

4. Create the database directory:
```bash
mkdir db
```

5. **Optional**: Create the sound effects directory for skip shield blocked sounds:
```bash
mkdir public/sfx
```
Add `.wav` or `.mp3` audio files to this directory for random playback when skips are blocked.

## Configuration

### Spotify Setup

1. Go to [Spotify for Developers](https://developer.spotify.com/)
2. Create a new application
3. Note down your Client ID and Client Secret
4. Set up the redirect URI in your Spotify app settings
5. Generate a refresh token for your Spotify account

### Formbar Integration

The application integrates with Formbar for user authentication and payment processing. Ensure you have:
- Valid Formbar API credentials
- Public key for JWT verification
- Access to the Digipogs payment system

## Usage

1. Start Formbar (either run a local instance or connect to formbeta.yorktechapps.com):
    - For local development: Follow the Formbar setup instructions on the [Formbar.js Wiki](https://github.com/csmith1188/Formbar.js/wiki/Hosting-Formbar.js-Locally) on starting your own version of formbar
    - For testing: Use the public instance at `formbeta.yorktechapps.com`

2. Start the application:
```bash
node app.js
```

3. Navigate to `http://localhost:3000` in your web browser

4. Log in through the Formbar authentication system

5. Search for songs using the search interface

6. Make a payment through Digipogs to unlock song playback (75 Digipogs per song, 100 Digipogs per skip)

7. **Optional**: Purchase skip shields (25 Digipogs) to protect your songs from being skipped

8. Add songs to the Spotify queue or play them directly

9. Toggle anonymous mode to add songs without tracking to your play count

## Key Features Explained

### Skip Shield System
- Purchase shields for 25 Digipogs per song to protect it from skips
- When someone attempts to skip a shielded song (costs 100 Digipogs), the shield is consumed instead
- Shield count is displayed on each queue item with a 🛡️ badge
- Random sound effects play when shields block skip attempts (requires audio files in `/public/sfx/`)

### Anonymous Mode
- Toggle the anonymous checkbox when adding songs
- Songs added anonymously don't increment your `songsPlayed` count on the leaderboard
- Still costs the same amount of Digipogs

### Real-time Queue Sync
- Queue and currently playing track update simultaneously via WebSocket
- Progress bar shows real-time playback position
- All users see updates instantly when songs are added, skipped, or shields are purchased

## Dependencies

- **express**: Web application framework
- **express-session**: Session middleware
- **ejs**: Template engine for views
- **spotify-web-api-node**: Spotify Web API wrapper
- **socket.io**: Real-time WebSocket communication
- **sqlite3**: SQLite database driver
- **jsonwebtoken**: JWT token handling
- **dotenv**: Environment variable management

## Database Schema

### Tables
- **users**: User accounts with Formbar IDs, Digipog balances, and play counts
- **queue_metadata**: Track metadata including who added songs, skip shield counts, and anonymous mode flags
- **transactions**: Complete audit log of all Digipog transactions (plays, skips, shield purchases)

## API Endpoints

### Authentication
- `GET /auth` - Formbar authentication redirect
- `GET /callback` - Formbar OAuth callback
- `POST /logout` - End user session

### Queue Management
- `POST /addToQueue` - Add a song to the Spotify queue
- `POST /skip` - Skip the currently playing track
- `POST /purchaseShield` - Purchase a skip shield for a specific track

### Payments
- `POST /payment/transfer` - Process Digipog payment for songs, skips, or shields
- `GET /payment/getAmount` - Get the cost for a specific action

### User Data
- `GET /api/leaderboard` - Fetch the top users by songs played
- `GET /api/queueHistory` - View transaction history (teacher access only)

## Contributing

Contributions are welcome! Please ensure all console logs are emoji-free for Raspberry Pi compatibility.

## License

This project is for educational purposes as part of the York Tech Apps ecosystem.