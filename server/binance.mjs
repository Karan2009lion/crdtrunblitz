// Binance spot API for the BTC/USDT bot: signed requests, the symbol's trading rules, and the
// handful of orders the bot needs (market buy, market sell, stop-loss, cancel, check).
import crypto from 'node:crypto';

export const SYMBOL = 'BTCUSDT';
export const BASES = {
  live: process.env.BINANCE_LIVE_URL || 'https://api.binance.com',
  testnet: process.env.BINANCE_TESTNET_URL || 'https://testnet.binance.vision',
};
/** A stop-loss sell is a stop-limit order; its limit sits this far under the stop so it fills in a fast drop. */
export const STOP_LIMIT_GAP = 0.005;

export const sign = (query, secret) => crypto.createHmac('sha256', secret).update(query).digest('hex');

/** Number of decimals in a step such as "0.00001000". */
function decimals(step) {
  const s = String(step);
  if (!s.includes('.')) return 0;
  return s.replace(/0+$/, '').split('.')[1]?.length ?? 0;
}

/** Rounds down to a multiple of `step`, returned as the plain decimal string Binance expects. */
export function floorTo(value, step) {
  const d = decimals(step);
  const st = Number(step);
  const n = Math.floor(value / st + 1e-9) * st;
  return n.toFixed(d);
}

/** The BTCUSDT trading rules that matter for our orders. */
export function rulesFrom(symbolInfo) {
  const f = Object.fromEntries(symbolInfo.filters.map((x) => [x.filterType, x]));
  const notional = f.NOTIONAL ?? f.MIN_NOTIONAL ?? {};
  return {
    tickSize: f.PRICE_FILTER?.tickSize ?? '0.01',
    stepSize: f.LOT_SIZE?.stepSize ?? '0.00001',
    minQty: Number(f.LOT_SIZE?.minQty ?? 0),
    minNotional: Number(notional.minNotional ?? 5),
  };
}

export class BinanceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Reads an order's fills into one average price, quantity, quote amount and fee in USDT. */
export function summariseFills(order, price) {
  const fills = order.fills ?? [];
  const qty = Number(order.executedQty);
  const quote = Number(order.cummulativeQuoteQty);
  const avgPrice = qty > 0 ? quote / qty : 0;
  let feeBtc = 0;
  let feeUsdt = 0;
  for (const f of fills) {
    const c = Number(f.commission);
    // A fee paid in another coin (for example BNB) comes out of that coin, not this trade.
    if (f.commissionAsset === 'BTC') feeBtc += c;
    else if (f.commissionAsset === 'USDT') feeUsdt += c;
  }
  return { qty, quote, avgPrice, feeBtc, feeUsdt: feeUsdt + feeBtc * (avgPrice || price || 0) };
}

export function createClient({ environment, apiKey, apiSecret, fetchImpl = fetch }) {
  const base = BASES[environment];
  if (!base) throw new Error(`Unknown environment ${environment}`);
  let offset = 0;
  let synced = false;
  let rules = null;

  async function request(method, path, params = {}, signed = false, retried = false) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const headers = {};
    if (signed) {
      if (!synced) await syncTime();
      q.set('timestamp', String(Date.now() + offset));
      q.set('recvWindow', '5000');
      q.set('signature', sign(q.toString(), apiSecret));
      headers['X-MBX-APIKEY'] = apiKey;
    }
    const url = `${base}${path}${q.size ? `?${q}` : ''}`;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new BinanceError(`Can't reach Binance (${e.cause?.code ?? e.message}). Check your internet connection.`, 'network', 0);
    }
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new BinanceError(`Binance sent an unexpected reply (HTTP ${res.status}).`, 'bad-reply', res.status);
    }
    if (!res.ok) {
      // Clock drift: resync once and retry.
      if (body.code === -1021 && !retried) {
        await syncTime();
        return request(method, path, params, signed, true);
      }
      throw new BinanceError(body.msg || `Binance error (HTTP ${res.status})`, body.code ?? res.status, res.status);
    }
    return body;
  }

  async function syncTime() {
    const t = await request('GET', '/api/v3/time');
    offset = t.serverTime - Date.now();
    synced = true;
  }

  async function getRules() {
    if (!rules) {
      const info = await request('GET', '/api/v3/exchangeInfo', { symbol: SYMBOL });
      rules = rulesFrom(info.symbols[0]);
    }
    return rules;
  }

  async function account() {
    const a = await request('GET', '/api/v3/account', { omitZeroBalances: 'true' }, true);
    const bal = (asset) => {
      const b = a.balances.find((x) => x.asset === asset);
      return { free: Number(b?.free ?? 0), locked: Number(b?.locked ?? 0) };
    };
    return { canTrade: a.canTrade !== false, USDT: bal('USDT'), BTC: bal('BTC') };
  }

  /** Live keys only: whether this key can withdraw money (null when Binance won't say). */
  async function canWithdraw() {
    if (environment !== 'live') return false;
    try {
      const r = await request('GET', '/sapi/v1/account/apiRestrictions', {}, true);
      return Boolean(r.enableWithdrawals);
    } catch {
      return null;
    }
  }

  async function marketBuy(quoteUsdt) {
    const r = await getRules();
    if (!(quoteUsdt >= r.minNotional)) throw new BinanceError(`Binance needs at least ${r.minNotional} USDT per order.`, 'too-small', 400);
    const o = await request('POST', '/api/v3/order', { symbol: SYMBOL, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteUsdt.toFixed(2), newOrderRespType: 'FULL' }, true);
    const s = summariseFills(o);
    return { orderId: o.orderId, time: o.transactTime ?? Date.now(), avgPrice: s.avgPrice, quote: s.quote, qty: s.qty - s.feeBtc, feeUsdt: s.feeUsdt };
  }

  async function marketSell(qty) {
    const r = await getRules();
    const quantity = floorTo(qty, r.stepSize);
    if (Number(quantity) < r.minQty || Number(quantity) <= 0) throw new BinanceError('The BTC amount is below what Binance allows in one order.', 'too-small', 400);
    const o = await request('POST', '/api/v3/order', { symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity, newOrderRespType: 'FULL' }, true);
    const s = summariseFills(o);
    return { orderId: o.orderId, time: o.transactTime ?? Date.now(), avgPrice: s.avgPrice, qty: s.qty, quote: s.quote - s.feeUsdt, feeUsdt: s.feeUsdt };
  }

  /** A stop-loss held by Binance: sells `qty` once the price falls to `stopPrice`. */
  async function stopLoss(qty, stopPrice) {
    const r = await getRules();
    const quantity = floorTo(qty, r.stepSize);
    const stop = floorTo(stopPrice, r.tickSize);
    const limit = floorTo(stopPrice * (1 - STOP_LIMIT_GAP), r.tickSize);
    const o = await request(
      'POST',
      '/api/v3/order',
      { symbol: SYMBOL, side: 'SELL', type: 'STOP_LOSS_LIMIT', timeInForce: 'GTC', quantity, price: limit, stopPrice: stop, newOrderRespType: 'RESULT' },
      true,
    );
    return { orderId: o.orderId, qty: Number(quantity), stopPrice: Number(stop), limitPrice: Number(limit) };
  }

  async function order(orderId) {
    const o = await request('GET', '/api/v3/order', { symbol: SYMBOL, orderId }, true);
    const qty = Number(o.executedQty);
    const quote = Number(o.cummulativeQuoteQty);
    return { orderId: o.orderId, status: o.status, qty, quote, avgPrice: qty > 0 ? quote / qty : 0, time: o.updateTime ?? o.time ?? Date.now() };
  }

  /** Cancels an order. If it already finished (for example the stop filled), says so and returns it. */
  async function cancel(orderId) {
    try {
      await request('DELETE', '/api/v3/order', { symbol: SYMBOL, orderId }, true);
      return { cancelled: true };
    } catch (e) {
      if (e.code === -2011) return { cancelled: false, order: await order(orderId) };
      throw e;
    }
  }

  return { account, canWithdraw, marketBuy, marketSell, stopLoss, order, cancel, getRules };
}
