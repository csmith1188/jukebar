const formpix = 'http://172.16.3.100:421';

require('dotenv').config({quiet: true});

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
const apikey = process.env.FORMBAR_API;

const reqOptions =
{
	method: 'POST',
	headers: {
		'API': apikey,
		'Content-Type': 'application/json'
	}
};

const barColor = '#00ff00';
const barEndColor = '#29ff29';

async function getAccessToken() {
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    });
    
    const data = await response.json();
    return data.access_token;
}

let userData = null;
let lastTrack = null;
let lastProgress = 0;
let lastProgressMs = 0;
let lastUpdateTime = 0;
let isPlaying = false;

async function getCurrentlyPlaying() {
    const accessToken = await getAccessToken();
    
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });
    
    if (response.status === 204 || response.status > 400) {
        throw new Error('No content or error from Spotify API');
    }
    
    const data = await response.json();

    userData = data;
    lastProgressMs = data.progress_ms || 0;
    lastUpdateTime = Date.now();
    isPlaying = data.is_playing || false;

    if(data.item && data.item.id === lastTrack?.id) {
        return null;
    }

    if (data && data.item && data.item.id !== lastTrack?.id) {
        userData = data;
        lastTrack = data.item;
        return data.item
    }

    if(!data.item) {
        lastTrack = null;
    }
}

getCurrentlyPlaying().catch(error => {
    console.error('Error fetching currently playing track:', error.message);
});

const interval = 3000; // 3 seconds

const progressInterval = 1000; // 1 second

fetch(`${formpix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.FORMPIX_LENGTH}`, reqOptions)
    .then(response => response.json())
    .catch((error) => console.error('Clear Error:', error));

const barUpdateInterval = setInterval(async () => {
    if(userData && lastTrack) {
        // Interpolate progress based on time elapsed since last Spotify update
        let currentProgressMs = lastProgressMs;
        if (isPlaying) {
            const elapsed = Date.now() - lastUpdateTime;
            currentProgressMs = Math.min(lastProgressMs + elapsed, lastTrack.duration_ms);
        }
        
        console.log(currentProgressMs, lastTrack.duration_ms);
        const progress = currentProgressMs / lastTrack.duration_ms;
        const fillLength = Math.floor(progress * process.env.FORMPIX_LENGTH);
        if(progress < lastProgress) {
            fetch(`${formpix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.FORMPIX_LENGTH}`, reqOptions)
                .then(response => response.json())
        }
        fetch(`${formpix}/api/gradient?startColor=${encodeURIComponent(barColor)}&endColor=${encodeURIComponent(barEndColor)}&length=${fillLength}`, reqOptions)
            .then(response => response.json())

        console.clear();
        console.log(`${lastTrack.name} - ${lastTrack.artists.map(artist => artist.name).join(', ')} | Progress: ${(progress * 100).toFixed(2)}% (${fillLength}/${process.env.FORMPIX_LENGTH})`);

        lastProgress = progress;
    }
}, progressInterval);

function displayTrack(track) {
    if (!track) return;
    
    const trackName = track.name || "No track playing";
    const artistName = track.artists ? track.artists.map(artist => artist.name).join(', ') : "Unknown Artist";
    const displayText = `${trackName} - ${artistName}          `;

    fetch(`${formpix}/api/say?text=${encodeURIComponent(displayText)}&textColor=${encodeURIComponent("#ffffff")}&backgroundColor=${encodeURIComponent("#000000")}`, reqOptions)
        .then(response => response.json())
        .then(data => console.log('Success:', data))
        .catch((error) => console.error('Error:', error));
}

const updateInterval = setInterval(async () => {
    let songUpdate = await getCurrentlyPlaying();

    if (!songUpdate) {
        return;
    }

    displayTrack(songUpdate);
}, interval);

async function initialCheck() {
    await getCurrentlyPlaying();
    displayTrack(lastTrack);
}

initialCheck();