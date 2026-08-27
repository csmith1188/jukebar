const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../utils/database');
const { setRawToken } = require('./socket');

function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

/**
 * Public base URL for OAuth redirects.
 * On Render, use URL or RENDER_EXTERNAL_URL (https://….onrender.com) — never append
 * the internal PORT. Locally, URL=http://localhost plus PORT still works.
 */
function getPublicBaseUrl() {
    const configured = stripTrailingSlash(
        process.env.URL || process.env.RENDER_EXTERNAL_URL || ''
    );
    const port = process.env.PORT || 5000;

    if (!configured) {
        return `http://localhost:${port}`;
    }

    try {
        const parsed = new URL(configured);
        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        // Legacy local template used URL=http://localhost without a port.
        if (isLocal && !parsed.port) {
            return `${parsed.protocol}//${parsed.hostname}:${port}`;
        }
        return stripTrailingSlash(parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname));
    } catch {
        return configured;
    }
}

const FORMBAR_ADDRESS = stripTrailingSlash(process.env.FORMBAR_ADDRESS);
const AUTH_URL = `${FORMBAR_ADDRESS}/oauth`;
const THIS_URL = `${getPublicBaseUrl()}/login`;

router.get('/login', (req, res) => {
    if (req.query.token) {
        const rawToken = req.query.token; // Get the actual raw token
        const tokenData = jwt.decode(rawToken);

        req.session.token = tokenData;
        req.session.user = tokenData.displayName;
        req.session.permission = tokenData.permissions;
        req.session.rawToken = rawToken;

        // Set the token for WebSocket authentication
        setRawToken(rawToken);

        // Update permission level on every login so it's available for ban checks
        db.run("UPDATE users SET permission = ? WHERE id = ?", [tokenData.permissions || 2, tokenData.id]);

        db.run("INSERT INTO users (id, displayName, pin) VALUES (?, ?, ?)", [tokenData.id, tokenData.displayName, null], (err) => {
            // if the table doesnt exist, create it
            if (err && err.message.includes('no such table')) {
                db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, displayName TEXT, pin INTERGER)", (err) => {
                    if (err) {
                        console.error('Error creating users table:', err.message);
                    } else {
                        // try inserting again
                        db.run("INSERT INTO users (id, displayName, pin) VALUES (?, ?, ?)", [tokenData.id, tokenData.displayName, null], (err) => {
                            if (err) {
                                if (err.message.includes('UNIQUE constraint failed')) {
                                    // User already exists
                                } else {
                                    console.error('Database error:', err.message);
                                }
                            } else {
//console.log('New user added to database');
                            }
                        });
                        const redirectTo = req.query.redirectURL || '/spotify';
                        res.redirect(redirectTo);
                    }
                });
            } else if (err && err.message.includes('UNIQUE constraint failed')) {
                const redirectTo = req.query.redirectURL || '/spotify';
                res.redirect(redirectTo);
            } else if (err) {
                console.error('Database error:', err.message);
                res.status(500).send('Database error');
            } else {
//console.log('New user added to database');
                const redirectTo = req.query.redirectURL || '/spotify';
                res.redirect(redirectTo);
            }
        });
    } else {
        res.redirect(`${AUTH_URL}?redirectURL=${encodeURIComponent(THIS_URL)}`);
    }
});

function getRawToken(req) {
    return req.session?.rawToken || null;
}

router.get('/logout', (req, res) => {
    res.redirect(`${AUTH_URL}?redirectURL=${encodeURIComponent(THIS_URL)}`);
    req.session.destroy();
});

module.exports = { router, getRawToken, getPublicBaseUrl };
