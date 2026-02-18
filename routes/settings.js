/**
 * JukePix Settings Routes
 * 
 * API endpoints for managing JukePix display settings:
 *   - Per-artist and per-song color overrides
 *   - Custom sound effects for skips/shields
 *   - Scroll speed configuration
 *   - Default/global display settings
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { isAuthenticated } = require('../middleware/auth');
const { isOwner } = require('../utils/owners');

// Middleware: only teachers/owners can change settings
const requireTeacher = (req, res, next) => {
    if (req.session?.permission >= 4 || isOwner(req.session?.token?.id)) {
        return next();
    }
    return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
};

// ─── GLOBAL / DEFAULT SETTINGS ───────────────────────────────────────────────

/**
 * GET /api/settings/defaults
 * Retrieve global JukePix default settings.
 */
router.get('/api/settings/defaults', isAuthenticated, requireTeacher, async (req, res) => {
    try {
        const defaults = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM jukepix_defaults WHERE id = 1', (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        res.json({ ok: true, defaults: defaults || {} });
    } catch (error) {
        console.error('Error fetching defaults:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch default settings' });
    }
});

/**
 * PUT /api/settings/defaults
 * Update global JukePix default settings.
 */
router.put('/api/settings/defaults', isAuthenticated, requireTeacher, async (req, res) => {
    try {
        const {
            text_color,
            bg_color,
            progress_fg1,
            progress_fg2,
            gradient_start,
            gradient_end,
            scroll_speed,
            skip_sound,
            shield_sound
        } = req.body;

        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE jukepix_defaults SET
                    text_color = COALESCE(?, text_color),
                    bg_color = COALESCE(?, bg_color),
                    progress_fg1 = COALESCE(?, progress_fg1),
                    progress_fg2 = COALESCE(?, progress_fg2),
                    gradient_start = COALESCE(?, gradient_start),
                    gradient_end = COALESCE(?, gradient_end),
                    scroll_speed = COALESCE(?, scroll_speed),
                    skip_sound = COALESCE(?, skip_sound),
                    shield_sound = COALESCE(?, shield_sound),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = 1
            `, [
                text_color, bg_color, progress_fg1, progress_fg2,
                gradient_start, gradient_end, scroll_speed,
                skip_sound, shield_sound
            ], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });

        res.json({ ok: true, message: 'Default settings updated' });
    } catch (error) {
        console.error('Error updating defaults:', error);
        res.status(500).json({ ok: false, error: 'Failed to update default settings' });
    }
});

// ─── PER-ARTIST / PER-SONG OVERRIDES ────────────────────────────────────────

/**
 * GET /api/settings/overrides
 * List all custom per-artist and per-song overrides.
 */
router.get('/api/settings/overrides', isAuthenticated, requireTeacher, async (req, res) => {
    try {
        const overrides = await new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM jukepix_settings ORDER BY match_type ASC, match_value ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
        res.json({ ok: true, overrides });
    } catch (error) {
        console.error('Error fetching overrides:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch overrides' });
    }
});

/**
 * POST /api/settings/overrides
 * Create a new per-artist or per-song override.
 * Body: { match_type, match_value, match_artist?, text_color?, progress_fg1?, progress_fg2?,
 *         skip_sound?, shield_sound?, scroll_speed? }
 */
router.post('/api/settings/overrides', isAuthenticated, requireTeacher, async (req, res) => {
    try {
        const {
            match_type,
            match_value,
            match_artist,
            text_color,
            progress_fg1,
            progress_fg2,
            skip_sound,
            shield_sound,
            scroll_speed
        } = req.body;

        // Validate required fields
        if (!match_type || !['artist', 'song'].includes(match_type)) {
            return res.status(400).json({ ok: false, error: 'match_type must be "artist" or "song"' });
        }
        if (!match_value || !match_value.trim()) {
            return res.status(400).json({ ok: false, error: 'match_value is required (artist name or song title)' });
        }

        await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO jukepix_settings
                    (match_type, match_value, match_artist, text_color, progress_fg1, progress_fg2,
                     skip_sound, shield_sound, scroll_speed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(match_type, match_value, match_artist)
                DO UPDATE SET
                    text_color = COALESCE(excluded.text_color, text_color),
                    progress_fg1 = COALESCE(excluded.progress_fg1, progress_fg1),
                    progress_fg2 = COALESCE(excluded.progress_fg2, progress_fg2),
                    skip_sound = COALESCE(excluded.skip_sound, skip_sound),
                    shield_sound = COALESCE(excluded.shield_sound, shield_sound),
                    scroll_speed = COALESCE(excluded.scroll_speed, scroll_speed),
                    updated_at = CURRENT_TIMESTAMP
            `, [
                match_type,
                match_value.trim(),
                match_artist ? match_artist.trim() : null,
                text_color || '#ffffff',
                progress_fg1 || '#00ff00',
                progress_fg2 || '#29ff29',
                skip_sound || null,
                shield_sound || null,
                scroll_speed || 50
            ], function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });

        res.json({ ok: true, message: 'Override saved' });
    } catch (error) {
        console.error('Error creating override:', error);
        res.status(500).json({ ok: false, error: 'Failed to save override' });
    }
});

/**
 * PUT /api/settings/overrides/:id
 * Update an existing override by ID.
 */
router.put('/api/settings/overrides/:id', isAuthenticated, requireTeacher, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            match_value,
            match_artist,
            text_color,
            progress_fg1,
            progress_fg2,
            skip_sound,
            shield_sound,
            scroll_speed
        } = req.body;

        const result = await new Promise((resolve, reject) => {
            db.run(`
                UPDATE jukepix_settings SET
                    match_value = COALESCE(?, match_value),
                    match_artist = COALESCE(?, match_artist),
                    text_color = COALESCE(?, text_color),
                    progress_fg1 = COALESCE(?, progress_fg1),
                    progress_fg2 = COALESCE(?, progress_fg2),
                    skip_sound = COALESCE(?, skip_sound),
                    shield_sound = COALESCE(?, shield_sound),
                    scroll_speed = COALESCE(?, scroll_speed),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [
                match_value, match_artist, text_color, progress_fg1, progress_fg2,
                skip_sound, shield_sound, scroll_speed, id
            ], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });

        if (result === 0) {
            return res.status(404).json({ ok: false, error: 'Override not found' });
        }
        res.json({ ok: true, message: 'Override updated' });
    } catch (error) {
        console.error('Error updating override:', error);
        res.status(500).json({ ok: false, error: 'Failed to update override' });
    }
});

/**
 * DELETE /api/settings/overrides/:id
 * Delete an override by ID.
 */
router.delete('/api/settings/overrides/:id', isAuthenticated, requireTeacher, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await new Promise((resolve, reject) => {
            db.run('DELETE FROM jukepix_settings WHERE id = ?', [id], function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });

        if (result === 0) {
            return res.status(404).json({ ok: false, error: 'Override not found' });
        }
        res.json({ ok: true, message: 'Override deleted' });
    } catch (error) {
        console.error('Error deleting override:', error);
        res.status(500).json({ ok: false, error: 'Failed to delete override' });
    }
});

/**
 * GET /api/settings/resolve?song=...&artist=...
 * Resolve the effective settings for a given song + artist.
 * Song overrides take priority over artist overrides,
 * which take priority over global defaults.
 */
router.get('/api/settings/resolve', async (req, res) => {
    try {
        const { song, artist } = req.query;

        // Get global defaults
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
            shield_sound: defaults.shield_sound || null,
            source: 'default'
        };

        // Layer 1: Artist override (lower priority)
        if (artist) {
            const artistOverride = await new Promise((resolve, reject) => {
                db.get(
                    "SELECT * FROM jukepix_settings WHERE match_type = 'artist' AND LOWER(TRIM(match_value)) = LOWER(TRIM(?))",
                    [artist],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            if (artistOverride) {
                effective.text_color = artistOverride.text_color || effective.text_color;
                effective.progress_fg1 = artistOverride.progress_fg1 || effective.progress_fg1;
                effective.progress_fg2 = artistOverride.progress_fg2 || effective.progress_fg2;
                effective.scroll_speed = artistOverride.scroll_speed || effective.scroll_speed;
                effective.skip_sound = artistOverride.skip_sound || effective.skip_sound;
                effective.shield_sound = artistOverride.shield_sound || effective.shield_sound;
                effective.source = 'artist';
            }
        }

        // Layer 2: Song override (higher priority — overrides artist)
        if (song) {
            const songOverride = await new Promise((resolve, reject) => {
                db.get(
                    "SELECT * FROM jukepix_settings WHERE match_type = 'song' AND LOWER(TRIM(match_value)) = LOWER(TRIM(?)) AND (match_artist IS NULL OR LOWER(TRIM(match_artist)) = LOWER(TRIM(?)))",
                    [song, artist || ''],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            if (songOverride) {
                effective.text_color = songOverride.text_color || effective.text_color;
                effective.progress_fg1 = songOverride.progress_fg1 || effective.progress_fg1;
                effective.progress_fg2 = songOverride.progress_fg2 || effective.progress_fg2;
                effective.scroll_speed = songOverride.scroll_speed || effective.scroll_speed;
                effective.skip_sound = songOverride.skip_sound || effective.skip_sound;
                effective.shield_sound = songOverride.shield_sound || effective.shield_sound;
                effective.source = 'song';
            }
        }

        res.json({ ok: true, settings: effective });
    } catch (error) {
        console.error('Error resolving settings:', error);
        res.status(500).json({ ok: false, error: 'Failed to resolve settings' });
    }
});

/**
 * GET /api/settings/sounds
 * List available sound files in /public/sfx for dropdown selection.
 */
router.get('/api/settings/sounds', isAuthenticated, requireTeacher, (req, res) => {
    const fs = require('fs');
    const path = require('path');

    try {
        const sfxDir = path.join(__dirname, '..', 'public', 'sfx');
        const files = fs.readdirSync(sfxDir)
            .filter(f => f.endsWith('.wav') || f.endsWith('.mp3'))
            .sort();
        res.json({ ok: true, sounds: files });
    } catch (error) {
        console.error('Error listing sounds:', error);
        res.json({ ok: true, sounds: [] });
    }
});

module.exports = router;
