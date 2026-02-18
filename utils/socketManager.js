/**
 * Socket Connection Manager
 * 
 * Manages a persistent socket.io connection to Formbar for
 * real-time communication (transfers, events, etc.).
 * 
 * Provides an emit-with-response pattern that wraps socket events
 * in Promises for clean async/await usage.
 */

const { io: ioClient } = require('socket.io-client');
require('dotenv').config({ quiet: true });

const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const API_KEY = process.env.API_KEY || '';

// Singleton socket instance
let socket = null;

// Connection state tracking
let isConnected = false;
let connectionPromise = null;

/**
 * Get or create the formbar socket connection.
 * Returns a connected socket instance.
 * @returns {Promise<import('socket.io-client').Socket>}
 */
function getSocket() {
    // Return existing connected socket
    if (socket && isConnected) {
        return Promise.resolve(socket);
    }

    // If a connection attempt is already in progress, wait for it
    if (connectionPromise) {
        return connectionPromise;
    }

    // Create a new connection
    connectionPromise = new Promise((resolve, reject) => {
        console.log('[SocketManager] Creating new Formbar socket connection...');

        socket = ioClient(FORMBAR_ADDRESS, {
            extraHeaders: { api: API_KEY },
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity, // Always try to reconnect
            timeout: 10000
        });

        // Connection succeeded
        socket.on('connect', () => {
            console.log('[SocketManager] Connected to Formbar:', socket.id);
            isConnected = true;
            connectionPromise = null;
            resolve(socket);
        });

        // Connection error (first connect attempt)
        socket.on('connect_error', (err) => {
            console.error('[SocketManager] Connection error:', err.message);
            if (connectionPromise) {
                connectionPromise = null;
                reject(new Error(`Failed to connect to Formbar: ${err.message}`));
            }
        });

        // Disconnected
        socket.on('disconnect', (reason) => {
            console.warn('[SocketManager] Disconnected from Formbar:', reason);
            isConnected = false;
        });

        // Reconnected
        socket.on('reconnect', (attemptNumber) => {
            console.log(`[SocketManager] Reconnected after ${attemptNumber} attempts`);
            isConnected = true;
        });

        // Reconnect failed
        socket.on('reconnect_failed', () => {
            console.error('[SocketManager] Reconnection failed permanently');
            isConnected = false;
        });
    });

    return connectionPromise;
}

/**
 * Emit an event and wait for a response event.
 * Implements request/response pattern over socket.io.
 * 
 * @param {string} emitEvent   - The event name to emit
 * @param {object} data        - The data to send
 * @param {string} responseEvent - The event name to listen for as a response (optional)
 * @param {number} timeoutMs   - Timeout in milliseconds (default 15s)
 * @returns {Promise<any>} The response data
 */
async function emitWithResponse(emitEvent, data, responseEvent = null, timeoutMs = 15000) {
    const sock = await getSocket();

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Socket request timed out after ${timeoutMs}ms for event: ${emitEvent}`));
        }, timeoutMs);

        // If a response event is specified, listen for it
        if (responseEvent) {
            sock.once(responseEvent, (responseData) => {
                clearTimeout(timer);
                resolve(responseData);
            });
        }

        // Emit with acknowledgment callback if no response event
        if (!responseEvent) {
            sock.emit(emitEvent, data, (ack) => {
                clearTimeout(timer);
                resolve(ack);
            });
        } else {
            sock.emit(emitEvent, data);
        }
    });
}

/**
 * Get the raw socket instance (for direct event listening).
 * @returns {import('socket.io-client').Socket|null}
 */
function getRawSocket() {
    return socket;
}

/**
 * Check if the socket is currently connected.
 * @returns {boolean}
 */
function isSocketConnected() {
    return isConnected && socket?.connected;
}

/**
 * Gracefully disconnect the socket.
 */
function disconnect() {
    if (socket) {
        socket.disconnect();
        socket = null;
        isConnected = false;
        connectionPromise = null;
        console.log('[SocketManager] Socket disconnected');
    }
}

module.exports = {
    getSocket,
    emitWithResponse,
    getRawSocket,
    isSocketConnected,
    disconnect
};
