import './styles.css';
import { signIn } from './login';

/**
 * Only one tab may run the app: two tabs would run two bots on the same paper account and
 * overwrite each other's saved state. The first tab holds a browser lock for as long as it is
 * open. Any other tab waits without loading the app, and takes over if the first one closes.
 */
const LOCK = 'crdtrade-bot';
const root = document.getElementById('root')!;
const forever = () => new Promise<never>(() => {});

async function start() {
  await signIn(root);
  root.replaceChildren();
  await import('./boot');
}

function showWaiting() {
  root.innerHTML = `
    <main class="one-tab" role="status">
      <h1>CRDTrade is already open in another tab</h1>
      <p>Only one tab can run the paper bot, so the test keeps a single account. Switch to the other tab.</p>
      <p class="muted">If you close the other tab, this one takes over automatically.</p>
    </main>`;
}

const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
if (!locks) {
  void start();
} else {
  void locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) {
      await start();
      return forever();
    }
    showWaiting();
    void locks.request(LOCK, async () => {
      await start();
      return forever();
    });
  });
}
