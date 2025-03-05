const express = require('express');
const router = express.Router();
const { spotifyApi, SPOTIFY_SCOPES } = require('./spotify/config');
const { handleSpotifySearch, handlePlayTrack } = require('./spotify/handlers');

router.get('/', (req, res) => {
    if (!req.session.user) {
        res.redirect(`http://localhost:420/oauth?redirectURL=http://localhost:3000/login`);
    } else {
        try {
            res.render('index.ejs', { username: req.session.user });
            console.log(req.session.token);
        } catch (error) {
            console.error('Render Error:', error);
            res.status(500).send(error.message);
        }
    }
});

router.get('/spotifyLogin', (_, res) => {
    res.redirect(spotifyApi.createAuthorizeURL(SPOTIFY_SCOPES));
});

router.get('/search', handleSpotifySearch);
router.post('/play', handlePlayTrack);

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

router.get('/youtube', (req, res) => {
    if (!req.session.user) {
        res.redirect(`http://localhost:420/oauth?redirectURL=http://localhost:3000/login`);
    } else {
        res.render('youtube.ejs');
    }
});

router.get('/spotify', (req, res) => {
    if (!req.session.user) {
        res.redirect(`http://localhost:420/oauth?redirectURL=http://localhost:3000/login`);
    } else {
        res.render('spotify.ejs');
    }
});

router.get('/soundboard', (req, res) => {
    if (!req.session.user) {
        res.redirect(`http://localhost:420/oauth?redirectURL=http://localhost:3000/login`);
    } else {
        res.render('soundboard.ejs');
    }
});

module.exports = router;

