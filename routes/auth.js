const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../utils/database');
const { setRawToken } = require('./socket');

const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const API_KEY = process.env.API_KEY || '';
const port = process.env.PORT || 5000;
const URL = process.env.URL || `http://localhost`;
const AUTH_URL = `${FORMBAR_ADDRESS}/oauth`;
const THIS_URL = `${URL}:${port}/login`;

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
        
        // console.log('Token data:', tokenData);
//console.log('User permission:', req.session.permission);
        
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
        res.redirect(`${AUTH_URL}?redirectURL=${THIS_URL}`);
    }
});

function getRawToken(req) {
    return req.session?.rawToken || null;
}

router.get('/logout', (req, res) => {
    res.redirect(`${AUTH_URL}?redirectURL=${THIS_URL}`);
    req.session.destroy();
});

module.exports = { router, getRawToken };
