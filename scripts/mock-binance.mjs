// A stand-in for Binance's spot API, for testing the real-trading code without money or a
// network. It checks request signatures like Binance does, keeps balances, fills market orders at
// a price you can move, and triggers stop-loss orders when the price falls to them.
//
//   MOCK_PORT=4180 node scripts/mock-binance.mjs
//   then start the app with BINANCE_TESTNET_URL=http://localhost:4180
//   POST /mock/price {"price": 80000}   moves the price (stops trigger)
import { createServer } from 'node:http';
import { sign } from '../server/binance.mjs';

const PORT = Number(process.env.MOCK_PORT || 4180);
const KEY = process.env.MOCK_KEY || 'test-api-key-0000000000';
const SECRET = process.env.MOCK_SECRET || 'test-api-secret-000000000';
const FEE = 0.001;

export const state = {
  price: Number(process.env.MOCK_PRICE || 80_000),
  balances: { USDT: { free: 1000, locked: 0 }, BTC: { free: 0, locked: 0 } },
  orders: new Map(),
  nextId: 1,
  log: [],
  /** Whether the key may withdraw money (POST /mock/withdraw {"on": true}). */
  withdraw: false,
};

const err = (res, status, code, msg) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code, msg }));
};
const ok = (res, data) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
};
const round8 = (n) => Math.round(n * 1e8) / 1e8;

function fill(side, qty, price) {
  const quote = qty * price;
  if (side === 'BUY') {
    state.balances.USDT.free = round8(state.balances.USDT.free - quote);
    state.balances.BTC.free = round8(state.balances.BTC.free + qty * (1 - FEE));
    return [{ price: String(price), qty: String(qty), commission: String(round8(qty * FEE)), commissionAsset: 'BTC' }];
  }
  state.balances.USDT.free = round8(state.balances.USDT.free + quote * (1 - FEE));
  return [{ price: String(price), qty: String(qty), commission: String(round8(quote * FEE)), commissionAsset: 'USDT' }];
}

/** Moving the price triggers any stop-loss at or above it. */
function setPrice(p) {
  state.price = p;
  for (const o of state.orders.values()) {
    if (o.type === 'STOP_LOSS_LIMIT' && o.status === 'NEW' && p <= o.stopPrice) {
      const at = Math.max(p, o.price);
      state.balances.BTC.locked = round8(state.balances.BTC.locked - o.origQty);
      state.balances.USDT.free = round8(state.balances.USDT.free + o.origQty * at * (1 - FEE));
      Object.assign(o, { status: 'FILLED', executedQty: o.origQty, cummulativeQuoteQty: o.origQty * at, updateTime: Date.now() });
      state.log.push(`stop ${o.orderId} filled at ${at}`);
    }
  }
}

const view = (o) => ({ ...o, executedQty: String(o.executedQty), cummulativeQuoteQty: String(o.cummulativeQuoteQty), origQty: String(o.origQty) });

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.searchParams;
  if (url.pathname === '/mock/price' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    setPrice(Number(JSON.parse(raw).price));
    return ok(res, { price: state.price, balances: state.balances });
  }
  if (url.pathname === '/mock/withdraw' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    state.withdraw = Boolean(JSON.parse(raw).on);
    return ok(res, { withdraw: state.withdraw });
  }
  if (url.pathname === '/mock/state') return ok(res, { price: state.price, balances: state.balances, orders: [...state.orders.values()], log: state.log });
  if (url.pathname === '/api/v3/time') return ok(res, { serverTime: Date.now() });
  if (url.pathname === '/api/v3/exchangeInfo') {
    return ok(res, {
      symbols: [
        {
          symbol: 'BTCUSDT',
          filters: [
            { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000.00', tickSize: '0.01' },
            { filterType: 'LOT_SIZE', minQty: '0.00001', maxQty: '9000.00', stepSize: '0.00001' },
            { filterType: 'NOTIONAL', minNotional: '5.00', applyMinToMarket: true },
          ],
        },
      ],
    });
  }

  // Signed endpoints: check the key and the signature over everything before &signature=.
  const raw = url.search.slice(1);
  const at = raw.lastIndexOf('&signature=');
  if (req.headers['x-mbx-apikey'] !== KEY) return err(res, 401, -2015, 'Invalid API-key, IP, or permissions for action.');
  if (at < 0 || sign(raw.slice(0, at), SECRET) !== raw.slice(at + 11)) return err(res, 400, -1022, 'Signature for this request is not valid.');
  if (Math.abs(Number(p.get('timestamp')) - Date.now()) > 5000) return err(res, 400, -1021, 'Timestamp for this request is outside of the recvWindow.');
  state.log.push(`${req.method} ${url.pathname} ${p.get('side') ?? ''} ${p.get('type') ?? ''}`.trim());

  if (url.pathname === '/api/v3/account') {
    return ok(res, { canTrade: true, balances: Object.entries(state.balances).map(([asset, b]) => ({ asset, free: String(b.free), locked: String(b.locked) })) });
  }
  if (url.pathname === '/sapi/v1/account/apiRestrictions') return ok(res, { enableWithdrawals: state.withdraw, enableSpotAndMarginTrading: true });
  if (url.pathname === '/api/v3/order' && req.method === 'POST') {
    const side = p.get('side');
    const type = p.get('type');
    const id = state.nextId++;
    if (type === 'MARKET') {
      const qty = side === 'BUY' ? round8(Number(p.get('quoteOrderQty')) / state.price) : Number(p.get('quantity'));
      if (side === 'BUY' && qty * state.price > state.balances.USDT.free + 1e-6) return err(res, 400, -2010, 'Account has insufficient balance for requested action.');
      if (side === 'SELL' && qty > state.balances.BTC.free + 1e-9) return err(res, 400, -2010, 'Account has insufficient balance for requested action.');
      if (side === 'SELL') state.balances.BTC.free = round8(state.balances.BTC.free - qty);
      const fills = fill(side, qty, state.price);
      const o = { symbol: 'BTCUSDT', orderId: id, status: 'FILLED', type, side, origQty: qty, executedQty: qty, cummulativeQuoteQty: round8(qty * state.price), transactTime: Date.now(), updateTime: Date.now() };
      state.orders.set(id, o);
      return ok(res, { ...view(o), fills });
    }
    if (type === 'STOP_LOSS_LIMIT') {
      const qty = Number(p.get('quantity'));
      if (qty > state.balances.BTC.free + 1e-9) return err(res, 400, -2010, 'Account has insufficient balance for requested action.');
      state.balances.BTC.free = round8(state.balances.BTC.free - qty);
      state.balances.BTC.locked = round8(state.balances.BTC.locked + qty);
      const o = { symbol: 'BTCUSDT', orderId: id, status: 'NEW', type, side, origQty: qty, executedQty: 0, cummulativeQuoteQty: 0, price: Number(p.get('price')), stopPrice: Number(p.get('stopPrice')), updateTime: Date.now() };
      state.orders.set(id, o);
      return ok(res, view(o));
    }
    return err(res, 400, -1116, 'Invalid orderType.');
  }
  const o = state.orders.get(Number(p.get('orderId')));
  if (url.pathname === '/api/v3/order' && req.method === 'DELETE') {
    if (!o || o.status !== 'NEW') return err(res, 400, -2011, 'Unknown order sent.');
    o.status = 'CANCELED';
    state.balances.BTC.locked = round8(state.balances.BTC.locked - o.origQty);
    state.balances.BTC.free = round8(state.balances.BTC.free + o.origQty);
    return ok(res, view(o));
  }
  if (url.pathname === '/api/v3/order' && req.method === 'GET') {
    if (!o) return err(res, 400, -2013, 'Order does not exist.');
    return ok(res, view(o));
  }
  return err(res, 404, -1, `Mock has no ${req.method} ${url.pathname}`);
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  server.listen(PORT, () => console.log(`Mock Binance on http://localhost:${PORT} (key ${KEY})`));
}
