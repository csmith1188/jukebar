// Initialize leaderboardLastReset on server start if not set
const express = require('express');
const session = require('express-session');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('leaderboardLastReset', Date.now());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'thisisasupersecretsigmaskibidikeyandihavethekeytotheuniversebutnobodywillknowabcdefghijklmnopqrstuvwxyz',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true on HTTPS in production
        httpOnly: true,
        sameSite: 'lax', // helps mitigate CSRF for top-level navigations
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

const { isAuthenticated } = require('./middleware/auth');

const { router: authRoutes } = require('./routes/auth');
const spotifyRoutes = require('./routes/spotify');
const paymentRoutes = require('./routes/payment');
const { router: leaderboardRoutes, checkAndResetLeaderboard } = require('./routes/leaderboard');
// const { setupFormbarSocket } = require('./routes/socket');

// Formbar Socket.IO connection
const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const API_KEY = process.env.API_KEY || '';

console.log('=== Formbar Configuration ===');
console.log('FORMBAR_ADDRESS:', FORMBAR_ADDRESS);
console.log('API_KEY present:', !!API_KEY);
console.log('=============================');

const formbarSocket = ioClient(FORMBAR_ADDRESS, {
    extraHeaders: { api: API_KEY }
});

console.log('Formbar socket client created, attempting connection...');

// setupFormbarSocket(io, formbarSocket);

// Main routes
app.get('/', isAuthenticated, (req, res) => {
    try {
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            hasPaid: !!req.session.hasPaid,
            payment: req.session.payment || null,
            userPermission: req.session.permission || null,
            ownerID: Number(process.env.OWNER_ID) || 4
        });
    } catch (error) {
        res.send(error.message);
    }
});

app.get('/spotify', isAuthenticated, (req, res) => {
    try {
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            hasPaid: !!req.session.hasPaid,
            payment: req.session.payment || null,
            userPermission: req.session.permission || null,
            ownerID: Number(process.env.OWNER_ID) || 4
        });
    } catch (error) {
        res.send(error.message);
    }
});

app.get('/leaderboard', isAuthenticated, (req, res) => {
    try {
        res.render('leaderboard.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            userPermission: req.session.permission || null,
            resetDate: req.app.get('leaderboardLastReset'),
            ownerID: Number(process.env.OWNER_ID) || 4
        });
    }
    catch (error) {
        res.send(error.message);
    }
});

app.get('/teacher', isAuthenticated, (req, res) => {
    try {
        if (req.session.permission >= 4 || req.session.token?.id === Number(process.env.OWNER_ID)) {
            res.render('teacher.ejs', {
                user: req.session.user,
                userID: req.session.token?.id,
                userPermission: req.session.permission || null,
                ownerID: Number(process.env.OWNER_ID) || 4
            });
        } else {
            res.redirect('/');
        }
    } catch (error) {
        res.send(error.message);
    }
});

app.use('/', authRoutes);
app.use('/', spotifyRoutes);
app.use('/', paymentRoutes);
app.use('/', leaderboardRoutes);

server.listen(port, async () => {
    console.log(`Server listening at http://localhost:${port}`);
});

module.exports = { app, io, formbarSocket };
