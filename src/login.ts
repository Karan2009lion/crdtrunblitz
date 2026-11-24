/**
 * Sign-in for the hosted website. When the build is given VITE_LOGIN_HASH (the SHA-256 of
 * "crdtrade:<user>:<password>"), the app asks for a user name and password before it loads;
 * a correct sign-in is remembered in this browser. Local builds have no hash and open straight away.
 *
 * This is a door sign, not a lock: the website is static, so the check runs in the browser and the
 * hash ships with the page. It keeps casual visitors out of a paper-money app; it would not stop
 * someone determined. Real-money trading never runs on the hosted website.
 */

const KEY = 'crdtrade-login';
export const LOGIN_HASH = (import.meta.env.VITE_LOGIN_HASH as string | undefined)?.trim().toLowerCase() || '';

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const remembered = () => {
  try {
    return localStorage.getItem(KEY) === LOGIN_HASH;
  } catch {
    return false;
  }
};

export function signOut() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  location.reload();
}

/** Resolves once the visitor is signed in (at once when there is no sign-in on this build). */
export function signIn(root: HTMLElement): Promise<void> {
  if (!LOGIN_HASH || remembered()) return Promise.resolve();
  return new Promise((resolve) => {
    root.innerHTML = `
      <main class="login">
        <form class="login-card" autocomplete="on">
          <div class="login-brand">CRDTrade</div>
          <h1>Sign in</h1>
          <label class="field">
            <span class="field-label">User name</span>
            <span class="input-wrap"><input id="login-user" name="username" autocomplete="username" required /></span>
          </label>
          <label class="field">
            <span class="field-label">Password</span>
            <span class="input-wrap"><input id="login-pass" name="password" type="password" autocomplete="current-password" required /></span>
          </label>
          <p class="error-text" id="login-error" role="alert" hidden></p>
          <button class="btn btn-buy" type="submit">Sign in</button>
          <p class="hint">Paper money only. No real orders are sent from this website.</p>
        </form>
      </main>`;
    const form = root.querySelector('form')!;
    const user = root.querySelector<HTMLInputElement>('#login-user')!;
    const pass = root.querySelector<HTMLInputElement>('#login-pass')!;
    const error = root.querySelector<HTMLElement>('#login-error')!;
    user.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hash = await sha256(`crdtrade:${user.value.trim().toLowerCase()}:${pass.value}`);
      if (hash !== LOGIN_HASH) {
        error.textContent = 'That user name and password don’t match. Check them and try again.';
        error.hidden = false;
        pass.select();
        return;
      }
      try {
        localStorage.setItem(KEY, hash);
      } catch {
        /* the sign-in then lasts until the page is closed */
      }
      resolve();
    });
  });
}
