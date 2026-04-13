const express = require('express');
const router = express.Router();
const { setJukepix, isJukepixEnabled, jukepix } = require('../utils/jukepix');

router.post('/toggleJukepix', (req, res) => {
    const { enabled } = req.body;
    console.log('[JUKEPIX ROUTE] Toggle request received:', { enabled, type: typeof enabled });

    if (typeof enabled !== 'boolean') {
        console.log('[JUKEPIX ROUTE] Invalid enabled value - must be boolean');
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (!jukepix) {
        console.log('[JUKEPIX ROUTE] Jukepix URL not configured');
        return res.status(400).json({ error: 'Jukepix URL is not configured' });
    }

    console.log('[JUKEPIX ROUTE] Setting Jukepix to:', enabled);
    const currentEnabled = setJukepix(enabled);

    if (enabled && !currentEnabled) {
        return res.status(400).json({ error: 'JUKEPIX_ENABLED is disabled, so JukePix cannot be enabled' });
    }

    res.json({ enabled: currentEnabled });
    console.log(`[JUKEPIX ROUTE] Jukepix is now ${currentEnabled ? 'enabled' : 'disabled'}.`);
});

router.get('/jukepixStatus', (req, res) => {
    res.json({ enabled: isJukepixEnabled() });
});

module.exports = router;
