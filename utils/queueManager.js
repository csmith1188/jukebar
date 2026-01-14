const { isJukepixEnabled, displayTrack } = require('./jukepix');

class QueueManager {
    constructor() {
        this.currentTrack = null;
        this.queue = [];
        this.isPlaying = false;
        this.progress = 0;
        this.lastUpdate = Date.now();
        this.clients = new Set(); // Connected WebSocket clients
        this.lastNetworkError = null; // Track last network error for rate limiting
    }

    // Update currently playing track
    updateCurrentTrack(track) {
        this.currentTrack = track;
        this.lastUpdate = Date.now();
        this.broadcastUpdate('currentTrack', track);
    }

    // Add track to queue
    addToQueue(track) {
        //console.log('addToQueue called with track:', track);
        this.queue.push(track);
        //console.log('Queue after adding:', this.queue.length, 'tracks');

        // Send queue update - but don't force currentTrack update (let Spotify sync handle that)
        this.broadcastUpdate('queueUpdate', {
            queue: this.queue,
            currentTrack: this.currentTrack, // Keep existing current track
            isPlaying: this.isPlaying,
            progress: this.progress,
            lastUpdate: this.lastUpdate
        });

        // Also send notification data
        this.broadcastUpdate('queueAdd', { track, queue: this.queue });
    }

    // Remove track from queue
    removeFromQueue(index) {
        const removed = this.queue.splice(index, 1)[0];
        this.broadcastUpdate('queueRemove', { removed, queue: this.queue });
        return removed;
    }

    // Skip to next track
    async skipTrack() {
        if (this.queue.length > 0) {
            const skippedTrack = this.currentTrack;
            const nextTrack = this.queue.shift();
            this.currentTrack = nextTrack; // Update current track when skipping
            this.lastUpdate = Date.now();

            // Clean up metadata for the skipped track ONLY if not still in queue
            if (skippedTrack && skippedTrack.uri) {
                const stillInQueue = this.queue.some(t => t.uri === skippedTrack.uri);
                
                if (!stillInQueue) {
                    await this.removeTrackMetadata(skippedTrack.uri);
                    console.log('Cleaned up metadata for skipped track:', skippedTrack.uri);
                } else {
                    console.log('Skipped track still in queue, keeping metadata');
                }
            }
            
            // Update previous track URI for sync detection
            this.previousTrackUri = nextTrack?.uri || null;

            // Send queue update with updated current track
            this.broadcastUpdate('queueUpdate', this.getCurrentState());
            // Send skip for notifications
            this.broadcastUpdate('skip', { currentTrack: this.currentTrack, queue: this.queue });
            return nextTrack;
        }
        return null;
    }

    // Update playback state  
    updatePlaybackState(isPlaying, progress = null) {
        this.isPlaying = isPlaying;
        if (progress !== null) this.progress = progress;
        this.lastUpdate = Date.now();

        // Add progress to currentTrack for display
        const currentTrackWithProgress = this.currentTrack ? {
            ...this.currentTrack,
            progress: this.progress
        } : null;

        this.broadcastUpdate('playbackState', {
            isPlaying: this.isPlaying,
            progress: this.progress,
            currentTrack: currentTrackWithProgress
        });
        // Also broadcast queue update when playback state changes
        this.broadcastUpdate('queueUpdate', { queue: this.queue });
    }

    // Get current state
    getCurrentState() {
        return {
            currentTrack: this.currentTrack,
            queue: this.queue,
            isPlaying: this.isPlaying,
            progress: this.progress,
            lastUpdate: this.lastUpdate
        };
    }

    // Broadcast updates to all connected clients
    broadcastUpdate(type, data) {
        //console.log(`Broadcasting ${type} event to ${this.clients.size} clients with data:`, data);

        let successCount = 0;
        let failCount = 0;

        this.clients.forEach(client => {
            try {
                // Handle Socket.IO clients
                if (client.emit && typeof client.emit === 'function') {
                    client.emit(type, data);
                    successCount++;
                }
                // Handle raw WebSocket clients (fallback)
                else if (client.readyState === 1) {
                    const message = JSON.stringify({ type, data, timestamp: Date.now() });
                    client.send(message);
                    successCount++;
                }
            } catch (error) {
                console.error(`Failed to send ${type} to client:`, error.message);
                failCount++;
            }
        });

        //console.log(`Broadcast complete: ${successCount} sent, ${failCount} failed`);
    }

    // Add WebSocket client
    addClient(ws) {
        this.clients.add(ws);
        // Send current state to new client
        if (ws.emit && typeof ws.emit === 'function') {
            // Socket.IO client
            ws.emit('queueUpdate', {
                type: 'initialState',
                data: this.getCurrentState(),
                timestamp: Date.now()
            });
        } else if (ws.readyState === 1) {
            // Raw WebSocket client
            ws.send(JSON.stringify({
                type: 'initialState',
                data: this.getCurrentState(),
                timestamp: Date.now()
            }));
        }
    }

    // Remove WebSocket client
    removeClient(ws) {
        this.clients.delete(ws);
    }

    // Initialize queue from Spotify on startup
    async initializeFromSpotify(spotifyApi) {
        console.log('initializeFromSpotify() called');
        try {
            console.log('Fetching current Spotify queue...');

            // Ensure we have a valid access token
            const { ensureSpotifyAccessToken } = require('./spotify');
            await ensureSpotifyAccessToken();

            // Get current playback to set the current track
            const currentPlayback = await spotifyApi.getMyCurrentPlayingTrack();
            if (currentPlayback.body && currentPlayback.body.item) {
                const currentUri = currentPlayback.body.item.uri;

                // Fetch metadata for current track (get oldest entry for duplicates)
                const db = require('./database');
                const currentMetadata = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT * FROM queue_metadata WHERE track_uri = ? ORDER BY added_at ASC LIMIT 1',
                        [currentUri],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                this.currentTrack = {
                    name: currentPlayback.body.item.name,
                    artist: currentPlayback.body.item.artists.map(a => a.name).join(', '),
                    uri: currentPlayback.body.item.uri,
                    duration: currentPlayback.body.item.duration_ms,
                    image: currentPlayback.body.item.album.images[0]?.url,
                    addedBy: currentMetadata ? currentMetadata.added_by : 'Spotify',
                    addedAt: currentMetadata ? currentMetadata.added_at : Date.now(),
                    isAnon: currentMetadata ? currentMetadata.is_anon : 0,
                    skipShields: currentMetadata ? currentMetadata.skip_shields : 0
                };
                this.isPlaying = currentPlayback.body.is_playing;
                this.progress = currentPlayback.body.progress_ms;
                //console.log('Current track set:', this.currentTrack.name);
            }

            // Try to get the user's queue using REST API (library methods don't work)
            try {
                console.log('Fetching queue via REST API...');
                const queueResponse = await fetch('https://api.spotify.com/v1/me/player/queue', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                });

                console.log('Queue API response status:', queueResponse.status);

                if (queueResponse.status === 200) {
                    const queueData = await queueResponse.json();
                    console.log('Queue data received, has queue?', !!queueData.queue);
                    console.log('Queue length:', queueData.queue?.length);

                    if (queueData.queue && Array.isArray(queueData.queue)) {
                        console.log('Found', queueData.queue.length, 'tracks in Spotify queue');

                        // 📖 Fetch metadata for all tracks from database
                        const trackUris = queueData.queue.map(item => item.uri);
                        const metadataMap = await this.getQueueMetadata(trackUris);
                        console.log('Metadata found for', Object.keys(metadataMap).length, 'tracks');

                        // 🆕 Create default metadata for tracks that don't have it
                        const db = require('./database');
                        for (const item of queueData.queue) {
                            if (!metadataMap[item.uri]) {
                                console.log('Creating metadata for:', item.name, '(URI:', item.uri, ')');
                                // Track exists in Spotify queue but not in our database
                                await new Promise((resolve, reject) => {
                                    db.run(
                                        `INSERT OR REPLACE INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon, skip_shields) 
                                         VALUES (?, ?, ?, ?, ?, ?)`,
                                        [item.uri, 'Spotify', Date.now(), 'Spotify', 0, 0],
                                        function (err) {
                                            if (err) {
                                                console.error('Failed to create default metadata:', err);
                                                reject(err);
                                            } else {
                                                console.log(`Created default metadata (changes: ${this.changes}, lastID: ${this.lastID})`);
                                                // Add to metadataMap so it's available immediately
                                                metadataMap[item.uri] = {
                                                    added_by: 'Spotify',
                                                    added_at: Date.now(),
                                                    is_anon: 0,
                                                    skip_shields: 0
                                                };
                                                resolve();
                                            }
                                        }
                                    );
                                });
                            } else {
                                console.log('Metadata already exists for:', item.name);
                            }
                        }

                        // Convert Spotify queue items to our format, merging with metadata
                        this.queue = queueData.queue.map(item => {
                            const metadata = metadataMap[item.uri];

                            return {
                                name: item.name,
                                artist: item.artists.map(a => a.name).join(', '),
                                uri: item.uri,
                                duration: item.duration_ms,
                                image: item.album.images[0]?.url,
                                addedBy: metadata ? metadata.added_by : 'Spotify',
                                addedAt: metadata ? metadata.added_at : Date.now(),
                                isAnon: metadata ? metadata.is_anon : 0,
                                skipShields: metadata ? metadata.skip_shields : 0
                            };
                        });

                        console.log('Initialized queue with', this.queue.length, 'tracks');
                    } else {
                        console.log('No queue array found in response');
                        this.queue = [];
                    }
                } else {
                    console.log('Queue API returned status:', queueResponse.status);
                    this.queue = [];
                }
            } catch (queueError) {
                console.log('Could not fetch Spotify queue:', queueError.message);
                console.log('Starting with empty queue - tracks will be added as they are queued');
                this.queue = [];
            }

            this.lastUpdate = Date.now();

        } catch (error) {
            console.error('Failed to initialize queue from Spotify:', error);
            // Don't throw - just continue with empty queue
            this.queue = [];
        }
    }

    // Track the previous track URI to detect track changes
    previousTrackUri = null;

    // Periodic Spotify sync (called every 5 seconds)
    async syncWithSpotify(spotifyApi) {
        try {
            // Fetch BOTH currently playing AND queue at the same time
            const [currentlyPlayingResponse, queueResponse] = await Promise.all([
                fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                }),
                fetch('https://api.spotify.com/v1/me/player/queue', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                })
            ]);

            // Process currently playing
            let currentTrack = null;
            if (currentlyPlayingResponse.status === 200) {
                const currentData = await currentlyPlayingResponse.json();
                if (currentData && currentData.item) {
                    currentTrack = {
                        id: currentData.item.id,
                        name: currentData.item.name,
                        artist: currentData.item.artists.map(a => a.name).join(', '),
                        uri: currentData.item.uri,
                        image: currentData.item.album.images?.[0]?.url || null,
                        album: {
                            name: currentData.item.album.name
                        },
                        duration_ms: currentData.item.duration_ms,
                        progress_ms: currentData.progress_ms
                    };
                    if(isJukepixEnabled()) displayTrack(currentTrack);
                }
            }

            // Process queue first (needed for track change detection)
            let queueTracks = [];
            if (queueResponse.status === 200) {
                const queueData = await queueResponse.json();
                queueTracks = queueData.queue || [];
            }

            // Detect track change - clean up metadata for PREVIOUS track ONLY if it's finished (not in queue and not currently playing)
            if (currentTrack && currentTrack.uri) {
                if (this.previousTrackUri && this.previousTrackUri !== currentTrack.uri) {
                    console.log('Track changed from', this.previousTrackUri, 'to', currentTrack.uri);
                    
                    // Check if previous track is still in the queue (duplicate) OR is the current track
                    const stillInQueue = queueTracks.some(t => t.uri === this.previousTrackUri);
                    const isCurrent = currentTrack.uri === this.previousTrackUri;
                    
                    if (!stillInQueue && !isCurrent) {
                        // Only remove metadata if track has completely finished (not in queue and not playing)
                        await this.removeTrackMetadata(this.previousTrackUri);
                        console.log('Removed metadata for finished track:', this.previousTrackUri);
                    } else {
                        console.log('Previous track still active (in queue or playing), keeping metadata');
                    }
                }
                this.previousTrackUri = currentTrack.uri;
            }

            // Get metadata for all tracks (including currently playing)
            const allUris = [
                ...(currentTrack ? [currentTrack.uri] : []),
                ...queueTracks.map(t => t.uri)
            ];

            const metadataMap = await this.getQueueMetadata(allUris);

            // Track which metadata entries we've already used
            const usedMetadata = new Set();

            // Add metadata to currently playing (use FIRST/oldest entry)
            if (currentTrack) {
                const metadataArray = metadataMap[currentTrack.uri];
                if (metadataArray && metadataArray.length > 0) {
                    // Use the first (oldest) metadata entry for currently playing
                    const metadata = metadataArray[0];
                    currentTrack.addedBy = metadata.added_by;
                    currentTrack.displayName = metadata.display_name;
                    currentTrack.isAnon = metadata.is_anon;
                    currentTrack.skipShields = metadata.skip_shields;
                    
                    // Mark this metadata as used so queue items don't use it
                    const metadataKey = `${currentTrack.uri}_${metadata.added_at}`;
                    usedMetadata.add(metadataKey);
                }
                // Add frontend-compatible property names
                currentTrack.progress = currentTrack.progress_ms;
                currentTrack.duration = currentTrack.duration_ms;
            }

            // Build queue with metadata, matching by position for duplicates
            const newQueue = queueTracks.map((track, index) => {
                const metadataArray = metadataMap[track.uri];
                let metadata = null;

                if (metadataArray && metadataArray.length > 0) {
                    // Find the first unused metadata entry for this URI (ordered by added_at)
                    for (let i = 0; i < metadataArray.length; i++) {
                        const metadataKey = `${track.uri}_${metadataArray[i].added_at}`;
                        
                        if (!usedMetadata.has(metadataKey)) {
                            metadata = metadataArray[i];
                            usedMetadata.add(metadataKey);
                            break;
                        }
                    }
                    // Fallback to first entry if all are used (shouldn't happen)
                    if (!metadata) {
                        metadata = metadataArray[0];
                    }
                }

                return {
                    uri: track.uri,
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    addedBy: metadata?.added_by || 'Spotify',
                    displayName: metadata?.display_name || 'Spotify',
                    addedAt: metadata?.added_at || Date.now(),
                    image: track.album?.images?.[0]?.url,
                    isAnon: metadata?.is_anon || 0,
                    skipShields: metadata?.skip_shields || 0
                };
            });

            // For currently playing, use the FIRST (oldest) metadata entry
            if (currentTrack) {
                const metadataArray = metadataMap[currentTrack.uri];
                if (metadataArray && metadataArray.length > 0) {
                    // Find the metadata entry that's NOT in the queue anymore (it's playing)
                    // This should be the one with the oldest added_at that doesn't match any queue position
                    const metadata = metadataArray[0]; // First entry is the one currently playing

                    currentTrack.addedBy = metadata.added_by;
                    currentTrack.displayName = metadata.display_name;
                    currentTrack.isAnon = metadata.is_anon;
                    currentTrack.skipShields = metadata.skip_shields;
                }
                // Add frontend-compatible property names
                currentTrack.progress = currentTrack.progress_ms;
                currentTrack.duration = currentTrack.duration_ms;
            }

            // Update internal state
            this.queue = newQueue;
            this.currentTrack = currentTrack;
            
            // Update progress from currentTrack if available
            if (currentTrack && currentTrack.progress_ms !== undefined) {
                this.progress = currentTrack.progress_ms;
            }

            // Broadcast BOTH at the same time using existing broadcast methods
            this.broadcastUpdate('queueUpdate', {
                queue: newQueue,
                currentTrack: currentTrack,
                isPlaying: this.isPlaying,
                progress: this.progress,
                lastUpdate: Date.now()
            });

            this.broadcastUpdate('currentTrack', currentTrack);

            return { currentTrack, queue: newQueue };
        } catch (error) {
            console.error('Error syncing with Spotify:', error.message || error);
            
            // Don't crash the server - return current state
            return { 
                currentTrack: this.currentTrack, 
                queue: this.queue 
            };
        }
    }

    // In getQueueMetadata, change to return ALL instances, not just first:
    async getQueueMetadata(trackUris) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            if (trackUris.length === 0) {
                resolve({});
                return;
            }

            const placeholders = trackUris.map(() => '?').join(',');
            const query = `SELECT track_uri, added_by, display_name, added_at, is_anon, skip_shields FROM queue_metadata WHERE track_uri IN (${placeholders}) ORDER BY added_at ASC`;

            db.all(query, trackUris, (err, rows) => {
                if (err) {
                    console.error('Failed to fetch queue metadata:', err);
                    resolve({});
                } else {
                    // BUILD A MAP with ARRAYS to handle duplicates
                    const metadataMap = {};

                    if (rows && rows.length > 0) {
                        for (const row of rows) {
                            // Store as array to handle multiple instances of same track
                            if (!metadataMap[row.track_uri]) {
                                metadataMap[row.track_uri] = [];
                            }
                            metadataMap[row.track_uri].push({
                                added_by: row.added_by,
                                display_name: row.display_name,
                                added_at: row.added_at,
                                is_anon: row.is_anon,
                                skip_shields: row.skip_shields
                            });
                        }
                    }

                    resolve(metadataMap);
                }
            });
        });
    }

    // Remove metadata for a track when it's played/skipped
    // Only removes the OLDEST entry if there are duplicates
    async removeTrackMetadata(trackUri) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            db.run(
                `DELETE FROM queue_metadata 
                 WHERE track_uri = ? 
                 AND added_at = (
                     SELECT MIN(added_at) 
                     FROM queue_metadata 
                     WHERE track_uri = ?
                 )`,
                [trackUri, trackUri],
                (err) => {
                    if (err) {
                        console.error('Failed to remove track metadata:', err);
                        reject(err);
                    } else {
                        //console.log('Removed metadata for track:', trackUri);
                        resolve();
                    }
                }
            );
        });
    }

    // 🧹 Cleanup: Remove metadata for tracks no longer in Spotify queue
    async cleanupStaleMetadata(currentQueueUris) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            // Get all track URIs currently in metadata table
            db.all('SELECT track_uri FROM queue_metadata', [], (err, rows) => {
                if (err) {
                    console.error('Failed to query metadata for cleanup:', err);
                    reject(err);
                    return;
                }

                if (!rows || rows.length === 0) {
                    // No metadata to clean up
                    resolve();
                    return;
                }

                const metadataUris = rows.map(row => row.track_uri);
                const staleUris = metadataUris.filter(uri => !currentQueueUris.includes(uri));

                if (staleUris.length === 0) {
                    // No stale metadata
                    resolve();
                    return;
                }

                // Delete stale metadata
                const placeholders = staleUris.map(() => '?').join(',');
                db.run(
                    `DELETE FROM queue_metadata WHERE track_uri IN (${placeholders})`,
                    staleUris,
                    function (err) {
                        if (err) {
                            console.error('Failed to delete stale metadata:', err);
                            reject(err);
                        } else {
                            console.log(`Cleaned up ${this.changes} stale track(s) from metadata`);
                            resolve();
                        }
                    }
                );
            });
        });
    }
}

// Global queue manager instance
const queueManager = new QueueManager();

module.exports = queueManager;