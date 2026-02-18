/**
 * Transfer Manager
 * 
 * Handles pool-based digipog transfers via Formbar socket.
 * Replaces the old HTTP-based transfer logic with socket events.
 * 
 * Transfer flow:
 *   1. Validate input (amount, sender, pool, PIN)
 *   2. Emit 'transferDigipogs' event with pool: true
 *   3. Wait for acknowledgment / response
 *   4. Return structured success or throw with error details
 * 
 * Falls back to HTTP if socket is unavailable for resilience.
 */

require('dotenv').config({ quiet: true });
const socketManager = require('./socketManager');

const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const POOL_ID = Number(process.env.POOL_ID);

/**
 * Validate transfer parameters before sending.
 * @param {object} params
 * @throws {Error} If validation fails
 */
function validateTransferParams({ from, to, amount, pin }) {
    if (!from || isNaN(Number(from))) {
        throw new Error('Invalid sender ID');
    }
    if (!to || isNaN(Number(to))) {
        throw new Error('Invalid recipient/pool ID');
    }
    if (!amount || Number(amount) <= 0) {
        throw new Error('Amount must be greater than 0');
    }
    if (pin == null || isNaN(Number(pin))) {
        throw new Error('Valid PIN is required');
    }
}

/**
 * Perform a pool-based transfer via Formbar socket.
 * 
 * @param {object} params
 * @param {number} params.from   - Sender user ID
 * @param {number} params.to     - Recipient/pool ID
 * @param {number} params.amount - Amount to transfer
 * @param {number} params.pin    - Sender's PIN
 * @param {string} params.reason - Reason for transfer
 * @returns {Promise<object>} Transfer response
 * @throws {Error} With message and optional .details property
 */
async function transfer({ from, to, amount, pin, reason = 'Jukebar Payment' }) {
    // Step 1: Validate inputs
    validateTransferParams({ from, to, amount, pin });

    const payload = {
        from: Number(from),
        to: Number(to),
        amount: Number(amount),
        reason: String(reason),
        pin: Number(pin),
        pool: true // Pool-based transfer
    };

    console.log('[TransferManager] Initiating pool transfer:', {
        from: payload.from,
        to: payload.to,
        amount: payload.amount,
        reason: payload.reason,
        pool: payload.pool
    });

    // Step 2: Try socket-based transfer first
    if (socketManager.isSocketConnected()) {
        try {
            const response = await socketManager.emitWithResponse(
                'transferDigipogs',
                payload,
                null, // Use ack callback pattern
                15000 // 15 second timeout
            );

            console.log('[TransferManager] Socket transfer response:', response);

            // Check for success
            if (response && (response.ok || response.success)) {
                return response;
            }

            // Check for error in response
            if (response && (response.error || response.message)) {
                const err = new Error(response.error || response.message || 'Transfer failed');
                err.details = response;
                throw err;
            }

            // If we got a truthy response, assume success
            if (response) {
                return response;
            }

            throw new Error('Empty response from Formbar');
        } catch (socketError) {
            // If it's a validation/business error, re-throw
            if (socketError.details) throw socketError;

            // Socket timeout or connection error - fall back to HTTP
            console.warn('[TransferManager] Socket transfer failed, falling back to HTTP:', socketError.message);
        }
    } else {
        console.warn('[TransferManager] Socket not connected, using HTTP fallback');
    }

    // Step 3: HTTP fallback
    return httpTransfer(payload);
}

/**
 * Perform a refund transfer (from owner back to user).
 * Uses the same pool transfer mechanism.
 * 
 * @param {object} params
 * @param {number} params.from   - Owner/pool ID (source of refund)
 * @param {number} params.to     - User ID (refund recipient)
 * @param {number} params.amount - Refund amount
 * @param {number} params.pin    - Owner's PIN
 * @param {string} params.reason - Reason for refund
 * @returns {Promise<object>}
 */
async function refund({ from, to, amount, pin, reason = 'Jukebar Refund' }) {
    // Refunds use the same transfer mechanism
    return transfer({ from, to, amount, pin, reason });
}

/**
 * HTTP fallback for transfers when socket is unavailable.
 * @param {object} payload - Transfer payload
 * @returns {Promise<object>}
 */
async function httpTransfer(payload) {
    console.log('[TransferManager] HTTP fallback transfer to:', FORMBAR_ADDRESS);

    try {
        const response = await fetch(`${FORMBAR_ADDRESS}/api/digipogs/transfer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const responseJson = await response.json();

        if (response.ok && responseJson) {
            return responseJson;
        }

        // Extract error message from various response formats
        let errorMessage = 'Transfer failed';

        // Try JWT token decode
        if (responseJson?.token) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.decode(responseJson.token);
                if (decoded?.message) errorMessage = decoded.message;
            } catch (_) { /* ignore decode error */ }
        }

        // Try direct message fields
        if (errorMessage === 'Transfer failed') {
            errorMessage = responseJson?.message
                || responseJson?.error
                || responseJson?.details?.message
                || responseJson?.data?.message
                || 'Transfer failed';
        }

        const err = new Error(errorMessage);
        err.details = responseJson;
        throw err;
    } catch (fetchError) {
        // If it's our structured error, re-throw
        if (fetchError.details) throw fetchError;

        // Network-level error
        throw new Error(`Failed to connect to Formbar: ${fetchError.message}`);
    }
}

/**
 * Transfer to pool (convenience function using POOL_ID from env).
 * @param {object} params
 * @param {number} params.from   - Sender user ID
 * @param {number} params.amount - Amount to transfer
 * @param {number} params.pin    - Sender's PIN
 * @param {string} params.reason - Reason for transfer
 * @returns {Promise<object>}
 */
async function transferToPool({ from, amount, pin, reason = 'Jukebar Payment' }) {
    return transfer({ from, to: POOL_ID, amount, pin, reason });
}

/**
 * Refund from pool (convenience function using POOL_ID from env).
 * @param {object} params
 * @param {number} params.to     - User ID (refund recipient)
 * @param {number} params.amount - Refund amount
 * @param {number} params.pin    - Owner's PIN
 * @param {string} params.reason - Reason for refund
 * @returns {Promise<object>}
 */
async function refundFromPool({ to, amount, pin, reason = 'Jukebar Refund' }) {
    return transfer({ from: POOL_ID, to, amount, pin, reason });
}

module.exports = {
    transfer,
    refund,
    transferToPool,
    refundFromPool,
    validateTransferParams
};
