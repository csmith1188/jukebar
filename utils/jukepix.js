
require('dotenv').config({quiet: true});

const spotifyApi = require('./spotify').spotifyApi;
const apikey = process.env.API_KEY;
const jukepix = process.env.JUKEPIX_URL;
const jukepixLength = process.env.JUKEPIX_LENGTH;

let jukepixEnabled = false;

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

let lastTrack = null;
let lastProgress = 0;

// const barUpdateInterval = setInterval(async () => {
//     if(!jukepixEnabled) return;
//     fetch('https://api.spotify.com/v1/me/player/currently-playing', {
//         method: 'GET',
//         headers: {
//             'Authorization': `Bearer ${spotifyApi.getAccessToken()}`
//         }
//     })
//     .then(response => response.json())
//     .then(data => {
//         if(data.progress_ms < lastProgress) {
//             fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`, reqOptions)
//                 .then(response => response.json())
//                 .catch((error) => console.error('Clear Error:', error));
//         }
//         const progress = data.progress_ms / data.item.duration_ms;
//         const fillLength = Math.floor(progress * jukepixLength);
        
//         fetch(`${jukepix}/api/gradient?startColor=${encodeURIComponent(barColor)}&endColor=${encodeURIComponent(barEndColor)}&length=${fillLength}`, reqOptions)
//             .then(response => response.json())
//             .catch((error) => console.error('Bar Error:', error));

//         lastProgress = data.progress_ms;
//     });
// }, 1000); 

function displayTrack(track) {
    if (!jukepixEnabled || !track) return;
    
    lastTrack = track;

    const trackName = track.name || "No Track Playing";
    const artistName = track.artist || "Unknown Artist";
    const displayText = `♪♫ ${trackName} - ${artistName} ♪♫        `;

    fetch(`${jukepix}/api/say?text=${encodeURIComponent(displayText)}&textColor=${encodeURIComponent("#ffffff")}&backgroundColor=${encodeURIComponent("#000000")}`, reqOptions)
        .then(response => response.json())
        .catch((error) => console.error('Error:', error));
}

function setJukepix(enabled) {
    jukepixEnabled = enabled;

    if(jukepixEnabled) {
        console.log('Enabling Jukepix display.');
        fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`, reqOptions)
            .then(response => response.json())
            .catch((error) => console.error('Clear Error:', error));

        fetch(`${jukepix}/api/say?text=Jukepix%20Enabled&textColor=${encodeURIComponent('#00ff00')}&backgroundColor=${encodeURIComponent('#000000')}`, reqOptions)
            .then(response => response.json())
            .catch((error) => console.error('Clear Error:', error));
    } else {
        console.log('Disabling Jukepix display.');
        fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`, reqOptions)
            .then(response => response.json())
            .catch((error) => console.error('Clear Error:', error));

        fetch(`${jukepix}/api/say?text=Jukepix%20Disabled&textColor=${encodeURIComponent('#ff0000')}&backgroundColor=${encodeURIComponent('#000000')}`, reqOptions)
            .then(response => response.json())
            .catch((error) => console.error('Clear Error:', error));

        setTimeout(() => {
            fetch(`${jukepix}/api/say?text=${encodeURIComponent(' ')}&textColor=${encodeURIComponent('#ffffff')}&backgroundColor=${encodeURIComponent('#000000')}`, reqOptions)
                .then(response => response.json())
                .catch((error) => console.error('Clear Error:', error));
        }, 1500);
    }

    return jukepixEnabled;
}

function isJukepixEnabled() {
    return jukepixEnabled;
}

module.exports = {
    displayTrack,
    setJukepix,
    isJukepixEnabled,
    jukepix
};