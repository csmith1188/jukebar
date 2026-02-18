
require('dotenv').config({ quiet: true });

const spotifyApi = require('./spotify').spotifyApi;
const db = require('./database');
const apikey = process.env.JUKEPIX_API_KEY;
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

/**
 * Resolve effective JukePix display settings for a track.
 * Priority: song override > artist override > global defaults.
 * @param {string} trackName
 * @param {string} artistName
 * @returns {Promise<object>} Effective settings
 */
async function resolveTrackSettings(trackName, artistName) {
    // Start with global defaults from DB
    const defaults = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM jukepix_defaults WHERE id = 1', (err, row) => {
            if (err) reject(err);
            else resolve(row || {});
        });
    });

    let effective = {
        text_color: defaults.text_color || '#ffffff',
        bg_color: defaults.bg_color || '#000000',
        progress_fg1: defaults.progress_fg1 || '#00ff00',
        progress_fg2: defaults.progress_fg2 || '#29ff29',
        scroll_speed: defaults.scroll_speed || 50,
        skip_sound: defaults.skip_sound || null,
        shield_sound: defaults.shield_sound || null
    };

    // Layer 1: Artist override
    if (artistName) {
        const artistOverride = await new Promise((resolve, reject) => {
            db.get(
                "SELECT * FROM jukepix_settings WHERE match_type = 'artist' AND LOWER(TRIM(match_value)) = LOWER(TRIM(?))",
                [artistName],
                (err, row) => { if (err) reject(err); else resolve(row); }
            );
        });
        if (artistOverride) {
            if (artistOverride.text_color) effective.text_color = artistOverride.text_color;
            if (artistOverride.progress_fg1) effective.progress_fg1 = artistOverride.progress_fg1;
            if (artistOverride.progress_fg2) effective.progress_fg2 = artistOverride.progress_fg2;
            if (artistOverride.scroll_speed) effective.scroll_speed = artistOverride.scroll_speed;
            if (artistOverride.skip_sound) effective.skip_sound = artistOverride.skip_sound;
            if (artistOverride.shield_sound) effective.shield_sound = artistOverride.shield_sound;
        }
    }

    // Layer 2: Song override (higher priority)
    if (trackName) {
        const songOverride = await new Promise((resolve, reject) => {
            db.get(
                "SELECT * FROM jukepix_settings WHERE match_type = 'song' AND LOWER(TRIM(match_value)) = LOWER(TRIM(?)) AND (match_artist IS NULL OR LOWER(TRIM(match_artist)) = LOWER(TRIM(?)))",
                [trackName, artistName || ''],
                (err, row) => { if (err) reject(err); else resolve(row); }
            );
        });
        if (songOverride) {
            if (songOverride.text_color) effective.text_color = songOverride.text_color;
            if (songOverride.progress_fg1) effective.progress_fg1 = songOverride.progress_fg1;
            if (songOverride.progress_fg2) effective.progress_fg2 = songOverride.progress_fg2;
            if (songOverride.scroll_speed) effective.scroll_speed = songOverride.scroll_speed;
            if (songOverride.skip_sound) effective.skip_sound = songOverride.skip_sound;
            if (songOverride.shield_sound) effective.shield_sound = songOverride.shield_sound;
        }
    }

    return effective;
}

const trackCheckInterval = setInterval(async () => {
    if (!jukepixEnabled) {
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
            duration: data.item.duration_ms,
            progress: data.progress_ms || 0
        };

        // Check if this is a new track
        if (!lastTrack || currentTrack.id !== lastTrack.id) {
            console.log('[JUKEPIX] New track detected:', currentTrack.name);

            // Resolve settings from DB (song > artist > defaults)
            const settings = await resolveTrackSettings(currentTrack.name, currentTrack.artist);
            console.log('[JUKEPIX] Resolved settings:', settings);

            // Strip '#' from hex colors for the API
            const fg1 = (settings.progress_fg1 || '#00ff00').replace('#', '');
            const fg2 = (settings.progress_fg2 || '#29ff29').replace('#', '');

            const progressBody = {
                fg1: fg1,
                fg2: fg2,
                startingFill: Math.round((currentTrack.progress / currentTrack.duration) * 100),
                duration: currentTrack.duration,
                interval: 100,
                length: parseInt(jukepixLength)
            };

            console.log('[JUKEPIX] Sending new track to formpix:', JSON.stringify(progressBody, null, 2));

            const params = new URLSearchParams(progressBody);
            const progressUrl = `${jukepix}/api/progress?${params.toString()}`;
            console.log('[JUKEPIX] Progress Request Details:', {
                url: progressUrl,
                method: 'POST',
                headers: {
                    'API': apikey ? `${apikey.substring(0, 8)}...` : 'none'
                }
            });
            fetch(progressUrl, {
                method: 'POST',
                headers: {
                    'API': apikey
                }
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
                        console.log('[JUKEPIX] New track progress sent successfully');
                        // Display track text with resolved settings
                        displayTrack(currentTrack, settings);
                    }
                    return response;
                })
                .catch((error) => console.error('[JUKEPIX] Progress Error:', { url: progressUrl, error: error.message, type: error.name }));

            lastTrack = currentTrack;
        } else {
            console.log('[JUKEPIX] Same track still playing:', currentTrack.name);
        }
    } catch (error) {
        console.error('[JUKEPIX] Track check error:', error.message, error);
    }
}, 2000); // Check every 2 seconds for new tracks 

function displayTrack(track, settings = null) {
    if (!jukepixEnabled || !track) return;

    try {
        const trackName = track.name || "No Track Playing";
        const artistName = track.artist || "Unknown Artist";
        const displayText = `♪♫ ${trackName} - ${artistName} ♪♫        `;

        // Use resolved settings if provided, otherwise fall back to defaults
        const textColor = (settings?.text_color || '#ffffff');
        const bgColor = (settings?.bg_color || '#000000');

        const sayUrl = `${jukepix}/api/say?text=${encodeURIComponent(displayText)}&textColor=${encodeURIComponent(textColor)}&backgroundColor=${encodeURIComponent(bgColor)}`;

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
            })
            .catch((error) => console.error('[JUKEPIX] Display track error:', { url: sayUrl, error: error.message, type: error.name }));
    } catch (error) {
        console.error('[JUKEPIX] displayTrack exception:', { error: error.message, type: error.name });
    }
}

function setJukepix(enabled) {
    jukepixEnabled = enabled;

    try {
        if (jukepixEnabled) {
            console.log('[JUKEPIX] ========== JUKEPIX ENABLED ==========');
            console.log('[JUKEPIX] Sending clear request to:', `${jukepix}/api/fill`);

            const enableClearUrl = `${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`;

            fetch(enableClearUrl, {
                ...reqOptions
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
                .catch((error) => console.error('[JUKEPIX] Clear Error:', { url: enableClearUrl, error: error.message, type: error.name }));

            // Delay the "enabled" message slightly
            setTimeout(() => {
                const enableMsgUrl = `${jukepix}/api/say?text=Jukepix%20Enabled&textColor=${encodeURIComponent('#00ff00')}&backgroundColor=${encodeURIComponent('#000000')}`;
                console.log('[JUKEPIX] Sending "enabled" message to:', enableMsgUrl);
                fetch(enableMsgUrl, {
                    ...reqOptions
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
                    .catch((error) => console.error('[JUKEPIX] Say Error:', { url: enableMsgUrl, error: error.message, type: error.name }));
            }, 500);
        } else {
            console.log('[JUKEPIX] Disabling Jukepix display.');
            console.log('[JUKEPIX] ========== JUKEPIX DISABLED - CLEARING TRACK DATA ==========');

            // Clear current and last track
            currentTrack = null;
            lastTrack = null;
            console.log('[JUKEPIX] Track data cleared');

            // Send fill black to clear the display
            const disableClearUrl = `${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`;
            console.log('[JUKEPIX] Sending fill black to clear display:', disableClearUrl);

            fetch(disableClearUrl, {
                ...reqOptions
            })
                .then(async response => {
                    console.log('[JUKEPIX] Fill black response status:', response.status);
                    if (!response.ok) {
                        const errorText = await response.text().catch(() => 'Unable to read error body');
                        console.error('[JUKEPIX] Fill black failed:', {
                            url: disableClearUrl,
                            status: response.status,
                            statusText: response.statusText,
                            errorBody: errorText,
                            sentApiKey: apikey ? `${apikey.substring(0, 8)}...` : 'none'
                        });
                    } else {
                        console.log('[JUKEPIX] Display cleared successfully');
                    }
                })
                .catch((error) => console.error('[JUKEPIX] Fill black error:', { url: disableClearUrl, error: error.message, type: error.name }));

            const disableClearUrl2 = `${jukepix}/api/fill?color=${encodeURIComponent('#000000')}&length=${process.env.JUKEPIX_LENGTH}`;

            setTimeout(() => {
                const disableMsgUrl = `${jukepix}/api/say?text=Jukepix%20Disabled&textColor=${encodeURIComponent('#ff0000')}&backgroundColor=${encodeURIComponent('#000000')}`;

                fetch(disableMsgUrl, {
                    ...reqOptions
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
                    .catch((error) => console.error('[JUKEPIX] Say Error:', { url: disableMsgUrl, error: error.message, type: error.name }));
            }, 500);

            setTimeout(() => {
                const clearTextUrl = `${jukepix}/api/say?text=${encodeURIComponent(' ')}&textColor=${encodeURIComponent('#ffffff')}&backgroundColor=${encodeURIComponent('#000000')}`;

                fetch(clearTextUrl, {
                    ...reqOptions
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
                    .catch((error) => console.error('[JUKEPIX] Clear Text Error:', { url: clearTextUrl, error: error.message, type: error.name }));
            }, 2000);
        }

        return jukepixEnabled;
    } catch (error) {
        console.error('[JUKEPIX] setJukepix exception:', { error: error.message, type: error.name });
        return jukepixEnabled;
    }
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