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
    skipTrack() {
        if (this.queue.length > 0) {
            const nextTrack = this.queue.shift();
            this.currentTrack = nextTrack; // Update current track when skipping
            this.lastUpdate = Date.now();

            // Don't delete metadata - keep it so shields persist for currently playing track
            // The metadata will be cleaned up by cleanupStaleMetadata() later

            //console.log('Skipped to next track:', nextTrack?.name);

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
        console.log('🎵 initializeFromSpotify() called');
        try {
            console.log('Fetching current Spotify queue...');

            // Ensure we have a valid access token
            const { ensureSpotifyAccessToken } = require('./spotify');
            await ensureSpotifyAccessToken();

            // Get current playback to set the current track
            const currentPlayback = await spotifyApi.getMyCurrentPlayingTrack();
            if (currentPlayback.body && currentPlayback.body.item) {
                const currentUri = currentPlayback.body.item.uri;

                // Fetch metadata for current track
                const db = require('./database');
                const currentMetadata = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT * FROM queue_metadata WHERE track_uri = ?',
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
                                                console.log(`✅ Created default metadata (changes: ${this.changes}, lastID: ${this.lastID})`);
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
                }
            }

            // Process queue
            let queueTracks = [];
            if (queueResponse.status === 200) {
                const queueData = await queueResponse.json();
                queueTracks = queueData.queue || [];
            }

            // Get metadata for all tracks (including currently playing)
            const allUris = [
                ...(currentTrack ? [currentTrack.uri] : []),
                ...queueTracks.map(t => t.uri)
            ];

            const metadataMap = await this.getQueueMetadata(allUris);

            // Add metadata to currently playing
            if (currentTrack) {
                const metadata = metadataMap[currentTrack.uri];
                if (metadata) {
                    currentTrack.addedBy = metadata.added_by;
                    currentTrack.displayName = metadata.display_name;
                    currentTrack.isAnon = metadata.is_anon;
                    currentTrack.skipShields = metadata.skip_shields;
                }
                // Add frontend-compatible property names
                currentTrack.progress = currentTrack.progress_ms;
                currentTrack.duration = currentTrack.duration_ms;
            }

            // Build queue with metadata
            const newQueue = queueTracks.map(track => {
                const metadata = metadataMap[track.uri];
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

            // Update internal state
            this.queue = newQueue;
            this.currentTrack = currentTrack;

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
            console.error('Error syncing with Spotify:', error);
            throw error;
        }
    }

    // Fetch metadata for multiple tracks from database
    async getQueueMetadata(trackUris) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            if (trackUris.length === 0) {
                resolve({});
                return;
            }

            const placeholders = trackUris.map(() => '?').join(',');
            const query = `SELECT track_uri, added_by, added_at, is_anon, skip_shields FROM queue_metadata WHERE track_uri IN (${placeholders})`;

            //console.log('Querying metadata for', trackUris.length, 'tracks');
            //console.log('Query:', query);
            //console.log('URIs:', trackUris);

            db.all(query, trackUris, (err, rows) => {
                if (err) {
                    console.error('Failed to fetch queue metadata:', err);
                    resolve({});
                } else {
                    //console.log('Found', rows ? rows.length : 0, 'metadata rows in database');
                    // Convert array to map for easy lookup
                    const metadataMap = {};
                    if (rows && rows.length > 0) {
                        rows.forEach(row => {
                            //console.log('Track', row.track_uri, 'added by:', row.added_by);
                            metadataMap[row.track_uri] = {
                                added_by: row.added_by,
                                added_at: row.added_at,
                                is_anon: row.is_anon,
                                skip_shields: row.skip_shields || 0
                            };
                        });
                    } else {
                        //console.log('No metadata rows found in database');
                    }
                    //console.log('Built metadata map with', Object.keys(metadataMap).length, 'entries');
                    resolve(metadataMap);
                }
            });
        });
    }

    // Remove metadata for a track when it's played/skipped
    async removeTrackMetadata(trackUri) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM queue_metadata WHERE track_uri = ?',
                [trackUri],
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
                            console.log(`🧹 Cleaned up ${this.changes} stale track(s) from metadata`);
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