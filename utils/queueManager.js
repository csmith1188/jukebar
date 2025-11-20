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
            
            // 🗑️ Clean up metadata for the skipped track
            if (nextTrack && nextTrack.uri) {
                this.removeTrackMetadata(nextTrack.uri).catch(err => {
                    console.error('Failed to remove track metadata on skip:', err);
                });
            }
            
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
        this.broadcastUpdate('playbackState', { 
            isPlaying: this.isPlaying, 
            progress: this.progress,
            currentTrack: this.currentTrack 
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
        try {
//console.log('Fetching current Spotify queue...');
            
            // Ensure we have a valid access token
            const { ensureSpotifyAccessToken } = require('./spotify');
            await ensureSpotifyAccessToken();
            
            // Get current playback to set the current track
            const currentPlayback = await spotifyApi.getMyCurrentPlayingTrack();
            if (currentPlayback.body && currentPlayback.body.item) {
                this.currentTrack = {
                    name: currentPlayback.body.item.name,
                    artist: currentPlayback.body.item.artists.map(a => a.name).join(', '),
                    uri: currentPlayback.body.item.uri,
                    duration: currentPlayback.body.item.duration_ms,
                    image: currentPlayback.body.item.album.images[0]?.url
                };
                this.isPlaying = currentPlayback.body.is_playing;
                this.progress = currentPlayback.body.progress_ms;
//console.log('Current track set:', this.currentTrack.name);
            }
            
            // Try to get the user's queue using available methods
            try {
                // Try different possible method names for getting queue
                let queueData = null;
                
                if (typeof spotifyApi.getQueue === 'function') {
                    queueData = await spotifyApi.getQueue();
                } else if (typeof spotifyApi.getMyQueue === 'function') {
                    queueData = await spotifyApi.getMyQueue();
                } else if (typeof spotifyApi.getUserQueue === 'function') {
                    queueData = await spotifyApi.getUserQueue();
                } else {
//console.log('Queue API method not available in this Spotify library version');
//console.log('Starting with empty queue - tracks will be added as they are queued');
                    this.queue = [];
                    return;
                }
                
                if (queueData && queueData.body && queueData.body.queue) {
//console.log('Found', queueData.body.queue.length, 'tracks in Spotify queue');
                    
                    // 📖 Fetch metadata for all tracks from database
                    const trackUris = queueData.body.queue.map(item => item.uri);
                    const metadataMap = await this.getQueueMetadata(trackUris);
                    
                    // Convert Spotify queue items to our format, merging with metadata
                    this.queue = queueData.body.queue.map(item => {
                        const metadata = metadataMap[item.uri];
                        
                        return {
                            name: item.name,
                            artist: item.artists.map(a => a.name).join(', '),
                            uri: item.uri,
                            duration: item.duration_ms,
                            image: item.album.images[0]?.url,
                            addedBy: metadata ? metadata.added_by : 'Spotify', // ✨ Use stored data if available
                            addedAt: metadata ? metadata.added_at : Date.now(),
                            isAnon: metadata ? metadata.is_anon : 0
                        };
                    });
                    
//console.log('Initialized queue with', this.queue.length, 'tracks');
                } else {
//console.log('No queue data found or queue is empty');
                    this.queue = [];
                }
            } catch (queueError) {
//console.log('Could not fetch Spotify queue:', queueError.message);
//console.log('Starting with empty queue - tracks will be added as they are queued');
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
            // Ensure we have a valid access token
            const { ensureSpotifyAccessToken } = require('./spotify');
            await ensureSpotifyAccessToken();
            
            const currentPlayback = await spotifyApi.getMyCurrentPlayingTrack();
            
            if (currentPlayback.body && currentPlayback.body.item && currentPlayback.body.is_playing !== undefined) {
                const track = {
                    name: currentPlayback.body.item.name,
                    artist: currentPlayback.body.item.artists.map(a => a.name).join(', '),
                    uri: currentPlayback.body.item.uri,
                    duration: currentPlayback.body.item.duration_ms,
                    image: currentPlayback.body.item.album.images[0]?.url
                };

                // Only broadcast if track changed
                if (!this.currentTrack || this.currentTrack.uri !== track.uri) {
//console.log('Track changed during sync, updating current track:', track.name);
                    this.updateCurrentTrack(track);
                } else {
//console.log('Track unchanged during sync:', track.name);
                }

                this.updatePlaybackState(
                    currentPlayback.body.is_playing,
                    currentPlayback.body.progress_ms
                );
            }

            // Also sync the queue from Spotify to keep it up-to-date
            try {
                const queueResponse = await fetch('https://api.spotify.com/v1/me/player/queue', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                });

                if (queueResponse.status === 200) {
                    const queueData = await queueResponse.json();
                    if (queueData.queue && Array.isArray(queueData.queue)) {
                        // 📖 Fetch metadata for all tracks from database
                        const trackUris = queueData.queue.map(item => item.uri);
//console.log('Syncing queue - requesting metadata for', trackUris.length, 'tracks');
                        const metadataMap = await this.getQueueMetadata(trackUris);
//console.log('Sync - received metadata for', Object.keys(metadataMap).length, 'tracks');
                        
                        // Only update our queue if Spotify has queue data
                        const spotifyQueue = queueData.queue.map(item => {
                            const metadata = metadataMap[item.uri];
                            const addedBy = metadata ? metadata.added_by : 'Spotify';
//console.log('Sync - Track:', item.name, 'addedBy:', addedBy);
                            return {
                                name: item.name,
                                artist: item.artists.map(a => a.name).join(', '),
                                uri: item.uri,
                                duration: item.duration_ms,
                                image: item.album.images[0]?.url,
                                addedBy: addedBy,
                                addedAt: Date.now(),
                                isAnon: metadata ? metadata.is_anon : 0
                            };
                        });

                        // Update our internal queue with Spotify's queue
                        this.queue = spotifyQueue;
//console.log(`Synced queue with Spotify: ${this.queue.length} tracks`);
                    }
                }
            } catch (queueError) {
                // Don't fail the whole sync if queue fetch fails
//console.log('Could not sync queue from Spotify:', queueError.message);
            }
        } catch (error) {
            // Handle network errors more gracefully
            if (error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                // Only log network errors once every minute to avoid spam
                if (!this.lastNetworkError || Date.now() - this.lastNetworkError > 60000) {
                    console.warn('Network error connecting to Spotify API - will retry:', error.code, error.hostname);
                    this.lastNetworkError = Date.now();
                }
            } else {
                // Log other errors normally
                console.error('Spotify sync error:', error.message || error);
            }
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
            const query = `SELECT track_uri, added_by, added_at, is_anon FROM queue_metadata WHERE track_uri IN (${placeholders})`;
            
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
                                is_anon: row.is_anon
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
}

// Global queue manager instance
const queueManager = new QueueManager();

module.exports = queueManager;