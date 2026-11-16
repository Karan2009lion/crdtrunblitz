// Runs the local server against the stand-in Binance (scripts/mock-binance.mjs): connecting keys,
// buying, the stop-loss held on Binance, cancelling and selling, and the safety checks.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { floorTo, rulesFrom, summariseFills } from './binance.mjs';

const MOCK = 4291;
const APP = 4292;
const KEY = 'test-api-key-0000000000';
const SECRET = 'test-api-secret-000000000';
const procs = [];
let data;

function start(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => /localhost/.test(String(d)) && resolve(p));
    p.stderr.on('data', (d) => reject(new Error(String(d))));
  });
}

const api = (path, { method = 'GET', body, headers = {} } = {}) =>
  fetch(`http://localhost:${APP}${path}`, {
    method,
    headers: { 'x-crdtrade': '1', 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const mock = (path, body) =>
  fetch(`http://localhost:${MOCK}${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'crdtrade-'));
  await start('node', ['scripts/mock-binance.mjs'], { MOCK_PORT: String(MOCK), MOCK_PRICE: '80000' });
  await start('node', ['server/index.mjs'], {
    PORT: String(APP),
    CRDTRADE_DATA: data,
    BINANCE_TESTNET_URL: `http://localhost:${MOCK}`,
    BINANCE_LIVE_URL: `http://localhost:${MOCK}`,
  });
}, 20_000);

afterAll(() => procs.forEach((p) => p.kill()));

describe('order maths', () => {
  it('rounds down to Binance steps', () => {
    expect(floorTo(0.0012487, '0.00001000')).toBe('0.00124');
    expect(floorTo(79123.456, '0.01000000')).toBe('79123.45');
    expect(floorTo(3, '1.00000000')).toBe('3');
  });
  it('reads the trading rules and fills', () => {
    const r = rulesFrom({ filters: [{ filterType: 'LOT_SIZE', minQty: '0.00001', stepSize: '0.00001' }, { filterType: 'NOTIONAL', minNotional: '5' }] });
    expect(r).toMatchObject({ stepSize: '0.00001', minNotional: 5 });
    const s = summariseFills({ executedQty: '0.002', cummulativeQuoteQty: '160', fills: [{ commission: '0.000002', commissionAsset: 'BTC' }] });
    expect(s.avgPrice).toBe(80000);
    expect(s.feeUsdt).toBeCloseTo(0.16, 6);
  });
});

describe('local server with a stand-in Binance', () => {
  it('only answers this app', async () => {
    expect((await api('/api/real/status', { headers: { 'x-crdtrade': '' } })).status).toBe(403);
    expect((await api('/api/real/status', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await api('/api/real/status')).body).toEqual({ connected: false });
  });

  it('rejects a wrong secret and keeps nothing', async () => {
    const r = await api('/api/real/connect', { method: 'POST', body: { environment: 'testnet', apiKey: KEY, apiSecret: 'wrong-secret-0000000000' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Signature/);
    expect((await api('/api/real/status')).body.connected).toBe(false);
  });

  it('refuses a real-money key that can withdraw, and accepts one that cannot', async () => {
    await mock('/mock/withdraw', { on: true });
    const refused = await api('/api/real/connect', { method: 'POST', body: { environment: 'live', apiKey: KEY, apiSecret: SECRET } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/can withdraw money/);
    expect((await api('/api/real/status')).body.connected).toBe(false);
    await mock('/mock/withdraw', { on: false });
    const r = await api('/api/real/connect', { method: 'POST', body: { environment: 'live', apiKey: KEY, apiSecret: SECRET } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, environment: 'live', keyHint: '…0000', withdrawCheck: 'off' });
    expect((await api('/api/real/disconnect', { method: 'POST' })).body.connected).toBe(false);
  });

  it('connects a testnet key, saves it privately and never sends the secret back', async () => {
    const r = await api('/api/real/connect', { method: 'POST', body: { environment: 'testnet', apiKey: KEY, apiSecret: SECRET } });
    expect(r.status).toBe(200);
    expect(r.body.balances.USDT.free).toBe(1000);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const file = join(data, 'binance-keys.json');
    expect(JSON.parse(await readFile(file, 'utf8')).apiSecret).toBe(SECRET);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('buys, holds a stop on Binance, and the stop fills when the price falls', async () => {
    const buy = await api('/api/real/buy', { method: 'POST', body: { quote: 100 } });
    expect(buy.status).toBe(200);
    expect(buy.body.avgPrice).toBe(80000);
    expect(buy.body.qty).toBeCloseTo(0.00125 * 0.999, 8);
    const stop = await api('/api/real/stop', { method: 'POST', body: { qty: buy.body.qty, stopPrice: 79000 } });
    expect(stop.body).toMatchObject({ qty: 0.00124, stopPrice: 79000, limitPrice: 78605 });
    expect((await api(`/api/real/order?orderId=${stop.body.orderId}`)).body.status).toBe('NEW');
    await mock('/mock/price', { price: 78900 });
    const done = (await api(`/api/real/order?orderId=${stop.body.orderId}`)).body;
    expect(done).toMatchObject({ status: 'FILLED', qty: 0.00124, avgPrice: 78900 });
    // Cancelling a stop that already filled says so instead of failing.
    const c = await api('/api/real/cancel', { method: 'POST', body: { orderId: stop.body.orderId } });
    expect(c.body).toMatchObject({ cancelled: false, order: { status: 'FILLED' } });
  });

  it('cancels the stop and sells at market', async () => {
    await mock('/mock/price', { price: 80000 });
    const buy = (await api('/api/real/buy', { method: 'POST', body: { quote: 200 } })).body;
    const stop = (await api('/api/real/stop', { method: 'POST', body: { qty: buy.qty, stopPrice: 78000 } })).body;
    expect((await api('/api/real/cancel', { method: 'POST', body: { orderId: stop.orderId } })).body).toEqual({ cancelled: true });
    await mock('/mock/price', { price: 81000 });
    const sell = await api('/api/real/sell', { method: 'POST', body: { qty: buy.qty } });
    expect(sell.status).toBe(200);
    expect(sell.body.avgPrice).toBe(81000);
    expect(sell.body.quote).toBeCloseTo(sell.body.qty * 81000 * 0.999, 4);
  });

  it('refuses to spend more than is free, and explains Binance errors', async () => {
    const r = await api('/api/real/buy', { method: 'POST', body: { quote: 5000 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/USDT is free/);
    expect((await api('/api/real/buy', { method: 'POST', body: { quote: 1 } })).body.error).toMatch(/at least 5 USDT/);
  });
});
