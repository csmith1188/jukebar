/**
 * Owner Validation Module
 * 
 * Supports multiple owners via OWNER_ID environment variable.
 * Accepts:
 *   - Single ID:       OWNER_ID=1
 *   - Comma-separated: OWNER_ID=1,2,3
 *   - JSON array:      OWNER_ID=[1,2,3]
 * 
 * All comparisons are done numerically for consistency.
 */

require('dotenv').config({ quiet: true });

/**
 * Parse OWNER_ID from environment into an array of numbers.
 * Backward-compatible: a single value still works.
 * @returns {number[]} Array of owner IDs
 */
function parseOwnerIds() {
    const raw = (process.env.OWNER_ID || '').trim();

    if (!raw) return [];

    // Try JSON array first: [1, 2, 3]
    if (raw.startsWith('[')) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map(Number).filter(n => !isNaN(n));
            }
        } catch (_) {
            // Fall through to comma-separated parsing
        }
    }

    // Comma-separated: "1,2,3"  or single: "1"
    return raw
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => !isNaN(n) && n !== 0);
}

// Cache the parsed owner IDs at module load
const ownerIds = parseOwnerIds();

/**
 * Check if a given user ID is an owner.
 * @param {number|string} userId - The user ID to check
 * @returns {boolean} True if the user is an owner
 */
function isOwner(userId) {
    if (userId == null) return false;
    return ownerIds.includes(Number(userId));
}

/**
 * Get all owner IDs as an array of numbers.
 * @returns {number[]}
 */
function getOwnerIds() {
    return [...ownerIds]; // Return a copy to prevent mutation
}

/**
 * Get the first (primary) owner ID.
 * Used for backward compatibility where a single owner is needed (e.g., transfer recipient).
 * @returns {number|null}
 */
function getFirstOwnerId() {
    return ownerIds.length > 0 ? ownerIds[0] : null;
}

module.exports = {
    isOwner,
    getOwnerIds,
    getFirstOwnerId
};
