# Jukebar

Jukebar is a nodejs jukebox application that integrates with Spotify and Formbar, allowing users to search for and play music by making payments with their Digipogs.

## Features

- **Spotify Integration**: Search and play music directly from Spotify
- **Authentication**: Secure login system with JWT tokens from Formbar accounts
- **Payment System**: Integrated with Formbar Digipogs for song purchases
- **Queue Management**: Add songs to the Spotify queue
- **Real-time Updates**: Socket.io integration for live updates
- **User Management**: SQLite database for user data and PIN storage
- **Session Management**: Secure session handling with Express

## Prerequisites

Before running this application, ensure you have:

- Node.js (version 14 or higher)
- A Spotify Premium account
- Spotify application registered with Spotify for Developers
- Access to Formbar API for payment processing
- A device with Spotify open and active for playback

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd JukebarRewrite
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

6. Make a payment through Digipogs to unlock song playback

7. Play songs directly or add them to the Spotify queue

## Dependencies

- **express**: Web application framework
- **express-session**: Session middleware
- **ejs**: Template engine for views
- **spotify-web-api-node**: Spotify Web API wrapper
- **socket.io**: Real-time communication
- **sqlite3**: SQLite database driver
- **jsonwebtoken**: JWT token handling
- **dotenv**: Environment variable management