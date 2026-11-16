// CRDTrade's local server: serves the built app at http://localhost:4173 and, for real trading,
// signs Binance orders with the API key saved on this computer. The key never reaches the browser,
// and the server only answers requests from this app on localhost.
//
//   node server/index.mjs        (start.sh / start.bat run this after building)
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BinanceError, createClient } from './binance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(process.env.CRDTRADE_DIST || join(ROOT, 'dist'));
const DATA = resolve(process.env.CRDTRADE_DATA || join(ROOT, '.crdtrade'));
const KEYS = join(DATA, 'binance-keys.json');
const PORT = Number(process.env.PORT || 4173);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------ saved keys */

let keys = null; // { environment, apiKey, apiSecret, connectedAt }
let client = null;

async function loadKeys() {
  try {
    keys = JSON.parse(await readFile(KEYS, 'utf8'));
    client = createClient(keys);
  } catch {
    keys = null;
    client = null;
  }
}

async function saveKeys(k) {
  await mkdir(DATA, { recursive: true });
  await writeFile(KEYS, JSON.stringify(k), { mode: 0o600 });
  await chmod(KEYS, 0o600).catch(() => {});
  keys = k;
  client = createClient(k);
}

const status = () =>
  keys ? { connected: true, environment: keys.environment, keyHint: `…${keys.apiKey.slice(-4)}`, connectedAt: keys.connectedAt } : { connected: false };

/* ------------------------------------------------------------ API routes */

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BinanceError(`${name} must be a positive number.`, 'bad-input', 400);
  return n;
};

function need() {
  if (!client) throw new BinanceError('Binance is not connected. Add your API key on the Profile screen.', 'not-connected', 409);
  return client;
}

const routes = {
  'GET /api/real/status': async () => status(),

  'POST /api/real/connect': async (body) => {
    const environment = body.environment === 'live' ? 'live' : body.environment === 'testnet' ? 'testnet' : null;
    const apiKey = String(body.apiKey ?? '').trim();
    const apiSecret = String(body.apiSecret ?? '').trim();
    if (!environment) throw new BinanceError('Choose Testnet or Real money.', 'bad-input', 400);
    if (apiKey.length < 16 || apiSecret.length < 16) throw new BinanceError('Paste both the API key and the secret key.', 'bad-input', 400);
    const trial = createClient({ environment, apiKey, apiSecret });
    const account = await trial.account();
    if (!account.canTrade) throw new BinanceError('This key is not allowed to trade. In Binance API Management, enable Spot trading for it.', 'no-trade', 400);
    const withdraw = await trial.canWithdraw();
    if (withdraw) {
      throw new BinanceError('This key can withdraw money, so it was not saved. In Binance API Management, turn off withdrawals for this key, then connect again.', 'can-withdraw', 400);
    }
    await saveKeys({ environment, apiKey, apiSecret, connectedAt: Date.now() });
    return { ...status(), balances: account, withdrawCheck: withdraw === null ? 'unknown' : 'off' };
  },

  'POST /api/real/disconnect': async () => {
    await rm(KEYS, { force: true });
    keys = null;
    client = null;
    return status();
  },

  'GET /api/real/balances': async () => ({ ...status(), balances: await need().account() }),

  'POST /api/real/buy': async (body) => {
    const c = need();
    const quote = num(body.quote, 'The amount');
    const a = await c.account();
    if (quote > a.USDT.free + 1e-9) throw new BinanceError(`Only ${a.USDT.free.toFixed(2)} USDT is free on Binance.`, 'no-funds', 400);
    return c.marketBuy(quote);
  },

  'POST /api/real/sell': async (body) => {
    const c = need();
    const a = await c.account();
    const qty = Math.min(num(body.qty, 'The BTC amount'), a.BTC.free);
    return c.marketSell(qty);
  },

  'POST /api/real/stop': async (body) => need().stopLoss(num(body.qty, 'The BTC amount'), num(body.stopPrice, 'The stop price')),

  'POST /api/real/cancel': async (body) => need().cancel(num(body.orderId, 'The order id')),

  'GET /api/real/order': async (_body, url) => need().order(num(url.searchParams.get('orderId'), 'The order id')),
};

/* ------------------------------------------------------------ server */

function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new BinanceError('Request too large.', 'bad-input', 413);
  }
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(req, res, url) {
  // Only this app, on this computer: the right host, our own page, and our header.
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '') || !okOrigin || req.headers['x-crdtrade'] !== '1') {
    return sendJson(res, 403, { error: 'Not allowed.' });
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return sendJson(res, 404, { error: 'Not found.' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    sendJson(res, 200, await route(body, url));
  } catch (e) {
    const code = e instanceof BinanceError ? (e.status >= 400 && e.status < 600 ? e.status : 502) : 500;
    sendJson(res, code, { error: e.message, code: e.code });
    if (!(e instanceof BinanceError)) console.error(e);
  }
}

async function handleStatic(req, res, url) {
  let file = join(DIST, normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return sendJson(res, 403, { error: 'Not allowed.' });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html'); // the app handles its own views
  }
  try {
    const data = await readFile(file);
    const hashed = file.includes(`${join(DIST, 'assets')}`);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. Run the start script so the app is built first.');
  }
}

await loadKeys();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  return void handleStatic(req, res, url);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is CRDTrade already running in another window?` : e.message);
  process.exit(1);
});
server.listen(PORT, 'localhost', () => {
  console.log(`  CRDTrade is serving http://localhost:${PORT}/${keys ? ` (Binance ${keys.environment === 'live' ? 'REAL MONEY' : 'Testnet'} connected)` : ''}`);
});
