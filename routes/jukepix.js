const express = require('express');
const router = express.Router();
const { setJukepix, isJukepixEnabled, jukepix } = require('../utils/jukepix');

router.post('/toggleJukepix', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if(!jukepix) {
        return res.status(400).json({ error: 'Jukepix URL is not configured' });
    }
    setJukepix(enabled);
    res.json({ enabled });
    console.log(`Jukepix is now ${enabled ? 'enabled' : 'disabled'}.`);
});

router.get('/jukepixStatus', (req, res) => {
    res.json({ enabled: isJukepixEnabled() });
});

module.exports = router;
