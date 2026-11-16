// Opens the app in the default browser once the local server answers. start.sh and start.bat run
// this alongside the server, so the page never opens onto an error (for example after a restart).
const { exec } = require('node:child_process');

const url = process.argv[2] || 'http://localhost:4173';
const deadline = Date.now() + 180_000;

function open() {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

(async function poll() {
  try {
    if ((await fetch(url)).ok) return open();
  } catch {
    /* not up yet */
  }
  if (Date.now() < deadline) setTimeout(poll, 1000);
  else console.log(`Open ${url} in your browser.`);
})();
