
require('dotenv').config({quiet: true});

const spotifyApi = require('./spotify').spotifyApi;
const apikey = process.env.API_KEY;
const jukepix = process.env.JUKEPIX_URL;
const jukepixLength = process.env.JUKEPIX_LENGTH;

console.log('[JUKEPIX] Configuration:', {
    url: jukepix,
    length: jukepixLength,
    hasApiKey: !!apikey
});

let jukepixEnabled = false;

const reqOptions =
{
	method: 'POST',
	headers: {
		'API': apikey,
		'Content-Type': 'application/json'
	}
};

let currentTrack = null;
let lastTrack = null;

const trackCheckInterval = setInterval(async () => {
    if(!jukepixEnabled) {
        console.log('[JUKEPIX] Track check skipped - Jukepix not enabled');
        return;
    }
    
    console.log('[JUKEPIX] Checking for new track');
    try {
        const accessToken = spotifyApi.getAccessToken();
        if (!accessToken) {
            console.error('[JUKEPIX] No Spotify access token available');
            return;
        }
        
        const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        console.log('[JUKEPIX] Spotify API response status:', response.status);
        
        if (response.status === 204) {
            console.log('[JUKEPIX] No track currently playing (204 No Content)');
            return;
        }
        
        const data = await response.json();
        console.log('[JUKEPIX] Current track data:', {
            hasData: !!data,
            hasItem: !!data?.item,
            trackName: data?.item?.name,
            trackId: data?.item?.id
        });
        
        if (!data || !data.item) {
            console.log('[JUKEPIX] No track data available');
            return;
        }
        
        currentTrack = {
            id: data.item.id,
            name: data.item.name,
            artist: data.item.artists?.[0]?.name || 'Unknown Artist',
            duration: data.item.duration_ms
        };
        
        // Check if this is a new track
        if (!lastTrack || currentTrack.id !== lastTrack.id) {
            console.log('[JUKEPIX] New track detected:', currentTrack.name);
            
            // Send track info to formpix
            const progressBody = {
                fg1: '00ff00',
                fg2: '29ff29',
                bg1: '000000',
                bg2: '000000',
                startingFill: 0,
                duration: currentTrack.duration,
                interval: 100,
                length: parseInt(jukepixLength)
            };
            
            console.log('[JUKEPIX] Sending new track to formpix:', JSON.stringify(progressBody, null, 2));
            
            const progressController = new AbortController();
            const progressTimeout = setTimeout(() => progressController.abort(), 3000);
            
            const progressUrl = `${jukepix}/api/progress`;
            fetch(progressUrl, {
                method: 'POST',
                headers: {
                    'API': apikey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(progressBody),
                signal: progressController.signal
            })
                .then(async response => {
                    console.log('[JUKEPIX] New track progress response status:', response.status);
                    const responseText = await response.text();
                    console.log('[JUKEPIX] New track progress response body:', responseText);
                    if (!response.ok) {
                        console.error('[JUKEPIX] Progress request failed:', {
                            url: progressUrl,
                            status: response.status,
                            statusText: response.statusText,
                            errorBody: responseText,
                            sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                        });
                    } else {
                        console.log('[JUKEPIX] New track sent successfully');
                    }
                    return response;
                })
                .catch((error) => console.error('[JUKEPIX] Progress Error:', { url: progressUrl, error: error.message, type: error.name }))
                .finally(() => clearTimeout(progressTimeout));
            
            lastTrack = currentTrack;
        } else {
            console.log('[JUKEPIX] Same track still playing:', currentTrack.name);
        }
    } catch (error) {
        console.error('[JUKEPIX] Track check error:', error.message, error);
    }
}, 2000); // Check every 2 seconds for new tracks 

function displayTrack(track) {
    if (!jukepixEnabled || !track) return;

    const trackName = track.name || "No Track Playing";
    const artistName = track.artist || "Unknown Artist";
    const displayText = `♪♫ ${trackName} - ${artistName} ♪♫        `;
    const sayUrl = `${jukepix}/api/say?text=${encodeURIComponent(displayText)}&textColor=${encodeURIComponent("#ffffff")}&backgroundColor=${encodeURIComponent("#000000")}`;

    fetch(sayUrl, reqOptions)
        .then(async response => {
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unable to read error body');
                console.error('[JUKEPIX] Display track failed:', {
                    url: sayUrl,
                    status: response.status,
                    statusText: response.statusText,
                    errorBody: errorText,
                    sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                });
            }
            return response.json();
        })
        .catch((error) => console.error('[JUKEPIX] Display track error:', { url: sayUrl, error: error.message, type: error.name }));
}

function setJukepix(enabled) {
    jukepixEnabled = enabled;

    if(jukepixEnabled) {
        console.log('[JUKEPIX] Enabling Jukepix display.');
        console.log('[JUKEPIX] Sending clear request to:', `${jukepix}/api/fill`);
        
        // Use non-blocking requests with timeout to prevent blocking Formbar
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000); // 3 second timeout
        const enableClearUrl = `${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`;
        
        fetch(enableClearUrl, {
            ...reqOptions,
            signal: controller.signal
        })
            .then(async response => {
                console.log('[JUKEPIX] Clear request response status:', response.status);
                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'Unable to read error body');
                    console.error('[JUKEPIX] Clear request failed:', {
                        url: enableClearUrl,
                        status: response.status,
                        statusText: response.statusText,
                        errorBody: errorText,
                        sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                    });
                }
                return response.json();
            })
            .catch((error) => console.error('[JUKEPIX] Clear Error:', { url: enableClearUrl, error: error.message, type: error.name }))
            .finally(() => clearTimeout(timeout));

        // Delay the "enabled" message slightly
        setTimeout(() => {
            const msgController = new AbortController();
            const msgTimeout = setTimeout(() => msgController.abort(), 3000);
            
            const enableMsgUrl = `${jukepix}/api/say?text=Jukepix%20Enabled&textColor=${encodeURIComponent('#00ff00')}&backgroundColor=${encodeURIComponent('#000000')}`;
            console.log('[JUKEPIX] Sending "enabled" message to:', enableMsgUrl);
            fetch(enableMsgUrl, {
                ...reqOptions,
                signal: msgController.signal
            })
                .then(async response => {
                    console.log('[JUKEPIX] "Enabled" message response status:', response.status);
                    if (!response.ok) {
                        const errorText = await response.text().catch(() => 'Unable to read error body');
                        console.error('[JUKEPIX] Enabled message failed:', {
                            url: enableMsgUrl,
                            status: response.status,
                            statusText: response.statusText,
                            errorBody: errorText,
                            sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                        });
                    }
                    return response.json();
                })
                .catch((error) => console.error('[JUKEPIX] Say Error:', { url: enableMsgUrl, error: error.message, type: error.name }))
                .finally(() => clearTimeout(msgTimeout));
        }, 500);
    } else {
        console.log('[JUKEPIX] Disabling Jukepix display.');
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const disableClearUrl = `${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`;
        
        fetch(disableClearUrl, {
            ...reqOptions,
            signal: controller.signal
        })
            .then(async response => {
                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'Unable to read error body');
                    console.error('[JUKEPIX] Disable clear failed:', {
                        url: disableClearUrl,
                        status: response.status,
                        statusText: response.statusText,
                        errorBody: errorText,
                        sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                    });
                }
                return response.json();
            })
            .catch((error) => console.error('[JUKEPIX] Clear Error:', { url: disableClearUrl, error: error.message, type: error.name }))
            .finally(() => clearTimeout(timeout));

        setTimeout(() => {
            const msgController = new AbortController();
            const msgTimeout = setTimeout(() => msgController.abort(), 3000);
            const disableMsgUrl = `${jukepix}/api/say?text=Jukepix%20Disabled&textColor=${encodeURIComponent('#ff0000')}&backgroundColor=${encodeURIComponent('#000000')}`;
            
            fetch(disableMsgUrl, {
                ...reqOptions,
                signal: msgController.signal
            })
                .then(async response => {
                    if (!response.ok) {
                        const errorText = await response.text().catch(() => 'Unable to read error body');
                        console.error('[JUKEPIX] Disable message failed:', {
                            url: disableMsgUrl,
                            status: response.status,
                            statusText: response.statusText,
                            errorBody: errorText,
                            sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                        });
                    }
                    return response.json();
                })
                .catch((error) => console.error('[JUKEPIX] Say Error:', { url: disableMsgUrl, error: error.message, type: error.name }))
                .finally(() => clearTimeout(msgTimeout));
        }, 500);

        setTimeout(() => {
            const clearController = new AbortController();
            const clearTimeout2 = setTimeout(() => clearController.abort(), 3000);
            const clearTextUrl = `${jukepix}/api/say?text=${encodeURIComponent(' ')}&textColor=${encodeURIComponent('#ffffff')}&backgroundColor=${encodeURIComponent('#000000')}`;
            
            fetch(clearTextUrl, {
                ...reqOptions,
                signal: clearController.signal
            })
                .then(async response => {
                    if (!response.ok) {
                        const errorText = await response.text().catch(() => 'Unable to read error body');
                        console.error('[JUKEPIX] Clear text failed:', {
                            url: clearTextUrl,
                            status: response.status,
                            statusText: response.statusText,
                            errorBody: errorText,
                            sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                        });
                    }
                    return response.json();
                })
                .catch((error) => console.error('[JUKEPIX] Clear Text Error:', { url: clearTextUrl, error: error.message, type: error.name }))
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