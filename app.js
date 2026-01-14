const { spawn } = require('child_process');

const main = spawn('node', ['apps/main.js'], { stdio: 'inherit' });
const jukepix = spawn('node', ['apps/jukepix.js'], { stdio: 'inherit' });

process.on('SIGINT', () => {
  main.kill();
  jukepix.kill();
  process.exit();
});
