const SpotifyWebApi = require('spotify-web-api-node');
const dotenv = require('dotenv');

dotenv.config();

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

const SPOTIFY_SCOPES = [
    'user-read-private', 
    'user-read-email', 
    'playlist-modify-public', 
    'playlist-modify-private', 
    'playlist-read-private', 
    'playlist-read-collaborative',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'streaming',
    'app-remote-control'
];

module.exports = {
    spotifyApi,
    SPOTIFY_SCOPES
};