const jwt = require('jsonwebtoken');

function isAuthenticated(req, res, next) {
    if (req.session.user) {
        const tokenData = req.session.token;

        try {
            // Check if the token has expired
            const currentTime = Math.floor(Date.now() / 1000);
            if (tokenData.exp < currentTime) {
                throw new Error('Token has expired');
            }
            next();
        } catch (err) {
            req.session.destroy();
            res.redirect('/login');
        }
    } else {
        res.redirect('/login');
    }
}

module.exports = {
    isAuthenticated
};
