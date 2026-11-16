/**
 * Keeps the screen (and with it, most computers) awake while the bot runs, so a long paper test
 * isn't interrupted by sleep. Browsers drop the lock when the tab is hidden, so it is re-acquired
 * whenever the tab becomes visible again.
 */
type Sentinel = { release(): Promise<void> };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

let wanted = false;
let sentinel: Sentinel | null = null;
let listening = false;

async function acquire() {
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  if (!wanted || sentinel || !api || document.visibilityState !== 'visible') return;
  try {
    sentinel = await api.request('screen');
    (sentinel as Sentinel & { addEventListener?(t: string, f: () => void): void }).addEventListener?.('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null; // not allowed here (battery saver, unsupported browser); the app still works
  }
}

export function keepAwake(on: boolean) {
  wanted = on;
  if (!listening && typeof document !== 'undefined') {
    listening = true;
    document.addEventListener('visibilitychange', () => void acquire());
  }
  if (on) void acquire();
  else if (sentinel) {
    void sentinel.release();
    sentinel = null;
  }
}

/** True only while the browser is actually holding the screen awake. */
export const screenKeptAwake = () => sentinel !== null;
