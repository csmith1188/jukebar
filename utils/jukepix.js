
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
let currentTrackDuration = 0;

const barUpdateInterval = setInterval(async () => {
    if(!jukepixEnabled) return;
    
    try {
        const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${spotifyApi.getAccessToken()}`
            }
        });
        
        const data = await response.json();
        
        if (!data || !data.item) return;
        
        const progress = data.progress_ms;
        const duration = data.item.duration_ms;
        
        // Check if track changed (reset progress bar)
        if (duration !== currentTrackDuration || progress < lastProgress) {
            currentTrackDuration = duration;
            lastProgress = 0;
            
            // Clear the bar when track changes
            await fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${jukepixLength}`, reqOptions);
        }
        
        // Calculate remaining time and fill percentage
        const remainingMs = duration - progress;
        const fillPercentage = Math.floor((progress / duration) * 100);
        
        // Send progress bar update with animation duration matching remaining track time
        const progressBody = {
            fg1: barColor,
            fg2: barEndColor,
            bg1: '#000000',
            bg2: '#000000',
            startingFill: fillPercentage,
            duration: remainingMs,
            interval: 100,
            length: parseInt(jukepixLength)
        };
        
        await fetch(`${jukepix}/api/progress`, {
            method: 'POST',
            headers: {
                'API': apikey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(progressBody)
        });
        
        lastProgress = progress;
    } catch (error) {
        console.error('Bar Update Error:', error);
    }
}, 5000); // Update every 5 seconds to keep animation in sync 

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