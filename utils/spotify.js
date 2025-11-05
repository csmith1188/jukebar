const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REFRESH_TOKEN
} = process.env;

const spotifyApi = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET
});

spotifyApi.setRefreshToken(SPOTIFY_REFRESH_TOKEN);

let accessTokenExpiresAt = 0;

async function ensureSpotifyAccessToken() {
  const now = Date.now();

  // Only refresh if token is expired or about to expire
  if (now > accessTokenExpiresAt) {
    try {
      const data = await spotifyApi.refreshAccessToken();
      const accessToken = data.body.access_token;
      const expiresIn = data.body.expires_in * 1000; // usually 3600s

      spotifyApi.setAccessToken(accessToken);
      accessTokenExpiresAt = now + expiresIn - 60 * 1000; // refresh 1 min early

      console.log('Spotify access token refreshed');
    } catch (err) {
      console.error('Failed to refresh Spotify token:', JSON.stringify(err, null, 2));
      throw err;
    }
  }
}

module.exports = {
    spotifyApi,
    ensureSpotifyAccessToken
};
