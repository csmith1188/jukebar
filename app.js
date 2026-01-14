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
