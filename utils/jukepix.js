
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
        if (duration !== currentTrackDuration || progress < lastProgress - 1000) {
            currentTrackDuration = duration;
            lastProgress = 0;
            
            // Clear the bar when track changes (non-blocking with timeout)
            const clearController = new AbortController();
            const clearTimeout = setTimeout(() => clearController.abort(), 3000);
            
            fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${jukepixLength}`, {
                ...reqOptions,
                signal: clearController.signal
            })
                .catch((error) => console.error('Jukepix Clear Error:', error.message))
                .finally(() => clearTimeout(clearTimeout));
        }
        
        // Calculate fill percentage based on current progress
        const fillPercentage = Math.floor((progress / duration) * 100);
        
        // Calculate time until next sync (15 seconds or end of song, whichever is shorter)
        const remainingMs = duration - progress;
        const animationDuration = Math.min(remainingMs, 15000);
        
        // Send progress bar update - starts at current position and animates for 15 seconds
        const progressBody = {
            fg1: barColor,
            fg2: barEndColor,
            bg1: '#000000',
            bg2: '#000000',
            startingFill: fillPercentage,
            duration: animationDuration,
            interval: 100,
            length: parseInt(jukepixLength)
        };
        
        // Non-blocking request with timeout
        const progressController = new AbortController();
        const progressTimeout = setTimeout(() => progressController.abort(), 3000);
        
        fetch(`${jukepix}/api/progress`, {
            method: 'POST',
            headers: {
                'API': apikey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(progressBody),
            signal: progressController.signal
        })
            .catch((error) => console.error('Jukepix Progress Error:', error.message))
            .finally(() => clearTimeout(progressTimeout));
        
        lastProgress = progress;
    } catch (error) {
        console.error('Bar Update Error:', error.message);
    }
}, 15000); // Sync every 15 seconds to correct progress bar position 

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
        
        // Use non-blocking requests with timeout to prevent blocking Formbar
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000); // 3 second timeout
        
        fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`, {
            ...reqOptions,
            signal: controller.signal
        })
            .then(response => response.json())
            .catch((error) => console.error('Jukepix Clear Error:', error.message))
            .finally(() => clearTimeout(timeout));

        // Delay the "enabled" message slightly
        setTimeout(() => {
            const msgController = new AbortController();
            const msgTimeout = setTimeout(() => msgController.abort(), 3000);
            
            fetch(`${jukepix}/api/say?text=Jukepix%20Enabled&textColor=${encodeURIComponent('#00ff00')}&backgroundColor=${encodeURIComponent('#000000')}`, {
                ...reqOptions,
                signal: msgController.signal
            })
                .then(response => response.json())
                .catch((error) => console.error('Jukepix Say Error:', error.message))
                .finally(() => clearTimeout(msgTimeout));
        }, 500);
    } else {
        console.log('Disabling Jukepix display.');
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        
        fetch(`${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`, {
            ...reqOptions,
            signal: controller.signal
        })
            .then(response => response.json())
            .catch((error) => console.error('Jukepix Clear Error:', error.message))
            .finally(() => clearTimeout(timeout));

        setTimeout(() => {
            const msgController = new AbortController();
            const msgTimeout = setTimeout(() => msgController.abort(), 3000);
            
            fetch(`${jukepix}/api/say?text=Jukepix%20Disabled&textColor=${encodeURIComponent('#ff0000')}&backgroundColor=${encodeURIComponent('#000000')}`, {
                ...reqOptions,
                signal: msgController.signal
            })
                .then(response => response.json())
                .catch((error) => console.error('Jukepix Say Error:', error.message))
                .finally(() => clearTimeout(msgTimeout));
        }, 500);

        setTimeout(() => {
            const clearController = new AbortController();
            const clearTimeout2 = setTimeout(() => clearController.abort(), 3000);
            
            fetch(`${jukepix}/api/say?text=${encodeURIComponent(' ')}&textColor=${encodeURIComponent('#ffffff')}&backgroundColor=${encodeURIComponent('#000000')}`, {
                ...reqOptions,
                signal: clearController.signal
            })
                .then(response => response.json())
                .catch((error) => console.error('Jukepix Clear Text Error:', error.message))
                .finally(() => clearTimeout(clearTimeout2));
        }, 2000);
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