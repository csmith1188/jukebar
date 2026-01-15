const { spawn } = require('child_process');

console.log('Starting Jukebar and Jukepix...');

const main = spawn('node', ['apps/main.js'], { stdio: 'inherit' });
const jukepix = spawn('node', ['apps/jukepix.js'], { stdio: 'inherit' });

main.on('error', (err) => {
  console.error('Failed to start main app:', err);
});

jukepix.on('error', (err) => {
  console.error('Failed to start jukepix:', err);
});

main.on('exit', (code) => {
  console.log(`Main app exited with code ${code}`);
});

jukepix.on('exit', (code) => {
  console.log(`Jukepix exited with code ${code}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  main.kill();
  jukepix.kill();
  process.exit();
});

// API endpoint to get online user count
app.get('/api/online-count', (req, res) => {
    const onlineCount = io.engine.clientsCount;
    res.json({ count: onlineCount });
});

// Debug endpoint to check Formbar connection status
app.get('/debug/formbar', isAuthenticated, (req, res) => {
    const { getCurrentClassroom } = require('./routes/socket');
    const classroom = getCurrentClassroom();
    
    res.json({
        connected: formbarSocket.connected,
        formbarAddress: FORMBAR_ADDRESS,
        hasApiKey: !!API_KEY,
        apiKeyLength: API_KEY.length,
        hasClassroom: !!classroom,
        classroom: classroom,
        socketId: formbarSocket.id,
        transport: formbarSocket.io ? formbarSocket.io.engine.transport.name : 'unknown'
    });
});

app.get('/leaderboard', isAuthenticated, (req, res) => {
    try {
        if (Date.now() - (req.app.get('leaderboardLastReset') || 0) > 6 * 24 * 60 * 60 * 1000) {
            checkAndResetLeaderboard(req.app);
        }
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
                jukepixEnabled: require('./utils/jukepix').isJukepixEnabled(),
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
app.use('/', userRoutes);
app.use('/', require('./routes/jukepix'));

server.listen(port, async () => {
    io.disconnectSockets();
    console.log(`Server listening at http://localhost:${port}`);
});

module.exports = { app, io, formbarSocket };
