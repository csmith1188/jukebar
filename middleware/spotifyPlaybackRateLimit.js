const READ = 'read';
const MODIFY = 'modify';

const CATEGORY_CONFIG = {
    // 30s effective throughput:
    // READ  -> ~49 requests per 30s  (12 + 1.25 * 30)
    // MODIFY-> ~14 requests per 30s  (4 + 0.35 * 30)
    [READ]: { capacity: 12, refillPerSec: 1.25 },
    [MODIFY]: { capacity: 4, refillPerSec: 0.35 }
};

const buckets = {
    [READ]: new Map(),
    [MODIFY]: new Map()
};
const cooldownUntilByCategory = {
    [READ]: 0,
    [MODIFY]: 0
};
// Consecutive-429 counters + exponential backoff cap. Every background job
// (queue sync, diagnostics loop, ban enforcer) shares this same state via
// setSpotifyPlaybackCooldown/resetSpotifyPlaybackBackoff, so repeated 429s
// escalate the wait instead of retrying at full speed forever, and a single
// confirmed success resets it back to normal.
const consecutive429CountByCategory = {
    [READ]: 0,
    [MODIFY]: 0
};
const SPOTIFY_MAX_BACKOFF_MS = Number(process.env.SPOTIFY_MAX_BACKOFF_MS) || 15 * 60 * 1000; // 15 min cap
const inFlightReads = new Map();
const modifyQueues = new Map();

function nowMs() {
    return Date.now();
}

function getRequesterKey(req) {
    const userId = req.session?.token?.id;
    if (userId !== null && userId !== undefined) {
        return `user:${userId}`;
    }
    return `ip:${req.ip || 'unknown'}`;
}

// Parses the Retry-After header value and returns the cooldown duration in milliseconds, defaulting to 10s if parsing fails
function parseRetryAfterMs(retryAfterHeaderValue) {
    const retryAfterSeconds = Number.parseInt(String(retryAfterHeaderValue || ''), 10);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return retryAfterSeconds * 1000;
    }
    return 10000;
}
// Sets a cooldown for the specified category based on the Retry-After header
// value, escalating exponentially on consecutive 429s (capped at
// SPOTIFY_MAX_BACKOFF_MS) instead of always retrying at the same flat delay.
// Logs the cooldown duration, escalation count, and source.
function setSpotifyPlaybackCooldown(category, retryAfterHeaderValue, source = 'spotify') {
    const baseMs = parseRetryAfterMs(retryAfterHeaderValue);
    const attempt = (consecutive429CountByCategory[category] || 0) + 1;
    consecutive429CountByCategory[category] = attempt;
    const waitMs = Math.min(baseMs * (2 ** (attempt - 1)), SPOTIFY_MAX_BACKOFF_MS);
    cooldownUntilByCategory[category] = nowMs() + waitMs;
    console.warn(`[playback-rate-limit] ${category} cooldown for ${Math.ceil(waitMs / 1000)}s (attempt #${attempt}, ${source})`);
    return waitMs;
}

// Call after a confirmed successful (non-429) Spotify response so a past
// rate-limit episode doesn't keep escalating wait times after recovery.
function resetSpotifyPlaybackBackoff(category) {
    consecutive429CountByCategory[category] = 0;
}

function getSpotifyPlaybackCooldownMs(category) {
    return Math.max(0, cooldownUntilByCategory[category] - nowMs());
}

// Extends the remaining cooldown to at least minMs without incrementing the
// consecutive-429 counter. Used by brokey-mode's floor so a confirmed 429
// that already recorded backoff isn't counted a second time.
function ensureSpotifyPlaybackCooldownFloor(category, minMs, source = 'spotify') {
    const remaining = getSpotifyPlaybackCooldownMs(category);
    const floorMs = Math.max(0, Number(minMs) || 0);
    if (remaining >= floorMs) return remaining;
    cooldownUntilByCategory[category] = nowMs() + floorMs;
    console.warn(`[playback-rate-limit] ${category} cooldown floor ${Math.ceil(floorMs / 1000)}s (${source})`);
    return floorMs;
}
// Middleware to enforce rate limits on Spotify playback-related requests using the token buckets 
function consumeToken(category, requesterKey) {
    const cfg = CATEGORY_CONFIG[category];
    const categoryBuckets = buckets[category];
    const current = categoryBuckets.get(requesterKey) || { tokens: cfg.capacity, lastRefill: nowMs() };
    const currentNow = nowMs();
    const elapsedSec = Math.max(0, (currentNow - current.lastRefill) / 1000);
    const refill = elapsedSec * cfg.refillPerSec;
    const tokens = Math.min(cfg.capacity, current.tokens + refill);
    const allowed = tokens >= 1;
    const nextState = {
        tokens: allowed ? tokens - 1 : tokens,
        lastRefill: currentNow
    };
    categoryBuckets.set(requesterKey, nextState);
    return {
        allowed,
        remainingTokens: nextState.tokens
    };
}

function getRetryAfterFromError(error) {
    return error?.headers?.['retry-after'] ||
        error?.response?.headers?.['retry-after'] ||
        error?.response?.headers?.get?.('retry-after') ||
        error?.body?.error?.retry_after;
}

function isSpotify429(error) {
    const status = error?.statusCode ?? error?.response?.statusCode ?? error?.body?.error?.status;
    return Number(status) === 429;
}

function build429Response(res, message, retryAfterMs) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
        ok: false,
        error: message,
        retryAfterSeconds: retryAfterSec
    });
}

function playbackRateLimit(category) {
    return (req, res, next) => {
        const cooldownMs = getSpotifyPlaybackCooldownMs(category);
        if (cooldownMs > 0) {
            return build429Response(
                res,
                `Spotify playback ${category} requests are cooling down. Please retry shortly.`,
                cooldownMs
            );
        }
        // Use requesterKey to track rate limits per user or IP
        const requesterKey = getRequesterKey(req);
        const bucketResult = consumeToken(category, requesterKey);
        if (!bucketResult.allowed) {
            console.warn(`[playback-rate-limit] blocked ${category} for ${requesterKey} route=${req.path}`);
            return build429Response(
                res,
                `Too many playback ${category} requests. Slow down and try again.`,
                1000
            );
        }
        req.spotifyPlaybackLimiter = {
            requesterKey
        };
        return next();
    };
}
// Executes a read operation with deduplication and rate limit handling
async function executePlaybackRead(req, operationKey, run) {
    const requesterKey = req?.spotifyPlaybackLimiter?.requesterKey || getRequesterKey(req || {});
    const dedupeKey = `${requesterKey}:${operationKey}`;
    if (inFlightReads.has(dedupeKey)) {
        return inFlightReads.get(dedupeKey);
    }

    const promise = (async () => {
        try {
            const result = await run();
            resetSpotifyPlaybackBackoff(READ);
            return result;
        } catch (error) {
            if (isSpotify429(error)) {
                setSpotifyPlaybackCooldown(READ, getRetryAfterFromError(error), operationKey);
            }
            throw error;
        } finally {
            inFlightReads.delete(dedupeKey);
        }
    })();
    inFlightReads.set(dedupeKey, promise);
    return promise;
}
// Executes a modify operation with queuing and rate limit handling
async function executePlaybackModify(req, operationKey, run) {
    const requesterKey = req?.spotifyPlaybackLimiter?.requesterKey || getRequesterKey(req || {});
    const queueKey = `${requesterKey}:${operationKey}`;
    const previous = modifyQueues.get(queueKey) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    modifyQueues.set(queueKey, previous.then(() => gate));

    await previous;
    try {
        const result = await run();
        resetSpotifyPlaybackBackoff(MODIFY);
        return result;
    } catch (error) {
        if (isSpotify429(error)) {
            setSpotifyPlaybackCooldown(MODIFY, getRetryAfterFromError(error), operationKey);
        }
        throw error;
    } finally {
        release();
        if (modifyQueues.get(queueKey) === gate) {
            modifyQueues.delete(queueKey);
        }
    }
}

module.exports = {
    READ,
    MODIFY,
    playbackRateLimit,
    executePlaybackRead,
    executePlaybackModify,
    setSpotifyPlaybackCooldown,
    resetSpotifyPlaybackBackoff,
    ensureSpotifyPlaybackCooldownFloor,
    getSpotifyPlaybackCooldownMs,
    getRetryAfterFromError,
    isSpotify429
};
