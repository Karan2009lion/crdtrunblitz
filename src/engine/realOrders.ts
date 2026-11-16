import type { Fill, Position, Trade } from '../types';
import { money, price as fmtPrice, signedMoney, uid } from '../lib/format';
import { MAX_FILLS, SYMBOL, useStore } from '../store/useStore';
import { realApi, type OrderStatus } from '../real/api';
import { refreshReal, useReal } from '../real/useReal';

/**
 * Real orders on Binance (Testnet or real money) through the local server. Positions record what
 * Binance actually filled. The stop loss is a stop order held by Binance, so it works even when the
 * app is closed; the bot cancels it before selling for any other reason.
 */

const get = useStore.getState;
const set = useStore.setState;
/** The bot sells by itself if the price falls this far through the stop (the Binance stop-limit may not fill in a gap). */
export const STOP_BACKUP_GAP = 0.006;

let buying = false;
let checking = false;
const closing = new Set<string>();
const stopRetryLogged = new Set<string>();
let lastExitAt = 0;

export const realBuying = () => buying;
/** True while an order or a stop check is going through; balances and the loss limit wait for it. */
export const realBusy = () => buying || checking || closing.size > 0;
export const realLastExit = () => lastExitAt;
const where = () => (get().tradingMode === 'live' ? 'on Binance (real money)' : 'on Binance Testnet');
const find = (id: string) => get().positions.find((p) => p.id === id);
const updatePosition = (id: string, patch: (p: Position) => Position) => set({ positions: get().positions.map((p) => (p.id === id ? patch(p) : p)) });

/** The free USDT on Binance right now (or the last known cash if Binance can't be reached). */
async function freshCash(): Promise<number> {
  await refreshReal();
  return useReal.getState().balances?.USDT.free ?? get().cash;
}

/** Keeps the account's cash equal to the free USDT on Binance. Cash is never counted up locally. */
export async function syncRealCash(): Promise<void> {
  if (get().tradingMode === 'paper' || realBusy()) return;
  const cash = await freshCash();
  if (get().tradingMode !== 'paper' && !realBusy()) set({ cash });
}

export async function openReal(amount: number, reason: string, levels: { stopPct: number; targetPct: number; situation?: string }, chartPrice: number): Promise<void> {
  if (buying || get().positions.length) return;
  buying = true;
  const env = get().tradingMode === 'live' ? 'live' : 'testnet';
  try {
    const b = await realApi.buy(amount);
    const ratio = env === 'testnet' && chartPrice > 0 ? b.avgPrice / chartPrice : 1;
    const pos: Position = {
      id: uid(),
      symbol: SYMBOL,
      side: 'long',
      qty: b.qty,
      entryPrice: b.avgPrice,
      entryTime: b.time,
      collateral: b.quote - b.feeUsdt,
      entryFee: b.feeUsdt,
      stopLoss: levels.stopPct > 0 ? b.avgPrice * (1 - levels.stopPct / 100) : null,
      takeProfit: levels.targetPct > 0 ? b.avgPrice * (1 + levels.targetPct / 100) : null,
      peak: b.avgPrice,
      openedBy: 'bot',
      reason,
      situation: levels.situation,
      real: { env, buyOrderId: b.orderId, priceRatio: ratio },
    };
    const fill: Fill = { id: uid(), time: b.time, symbol: SYMBOL, action: 'buy', kind: 'open', qty: b.qty, price: b.avgPrice, by: 'bot' };
    // Cash and the new position change together, so the account value never jumps in between.
    const cash = await freshCash();
    const s = get();
    set({
      cash,
      positions: [...s.positions, pos],
      fills: [...s.fills, fill].slice(-MAX_FILLS),
      orderTimes: [...s.orderTimes.filter((t) => t > Date.now() - 60000), Date.now()],
    });
    get().log('buy', `Bought ${b.qty.toFixed(5)} BTC ${where()} for ${money(b.quote)} at ${fmtPrice(b.avgPrice)}. ${reason}`, SYMBOL);
    get().toast('info', `Bought BTC ${where()} at ${fmtPrice(b.avgPrice)}`);
    if (pos.stopLoss) await placeStop(pos.id);
  } catch (e) {
    get().log('warn', `Buy ${where()} failed: ${(e as Error).message}`, SYMBOL);
    get().toast('bad', `Buy failed: ${(e as Error).message}`);
  } finally {
    buying = false;
  }
}

async function placeStop(id: string): Promise<void> {
  const p = find(id);
  if (!p?.real || !p.stopLoss || p.real.stopOrderId) return;
  try {
    const o = await realApi.stop(p.qty, p.stopLoss);
    updatePosition(id, (x) => ({ ...x, stopLoss: o.stopPrice, real: { ...x.real!, stopOrderId: o.orderId } }));
    stopRetryLogged.delete(id);
    get().log('info', `Stop loss placed ${where()}: sells ${o.qty} BTC if the price falls to ${fmtPrice(o.stopPrice)} (at no less than ${fmtPrice(o.limitPrice)}).`, SYMBOL);
  } catch (e) {
    if (!stopRetryLogged.has(id)) {
      stopRetryLogged.add(id);
      get().log('warn', `Couldn't place the stop loss ${where()} (${(e as Error).message}). While the app is open, the bot watches the price and sells itself; it will keep trying to place the stop.`, SYMBOL);
      get().toast('bad', 'Stop loss not placed on Binance. The bot is watching the price instead.');
    }
  }
}

function recordClose(p: Position, sold: { qty: number; quote: number; avgPrice: number; feeUsdt: number; time: number }, reason: string, cash: number) {
  const share = Math.min(1, sold.qty / p.qty);
  const cost = (p.collateral + p.entryFee) * share;
  const pnl = sold.quote - cost;
  const trade: Trade = {
    id: p.id,
    symbol: p.symbol,
    side: 'long',
    qty: sold.qty,
    entryPrice: p.entryPrice,
    exitPrice: sold.avgPrice,
    entryTime: p.entryTime,
    exitTime: sold.time,
    pnl,
    pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
    fees: p.entryFee * share + sold.feeUsdt,
    openedBy: p.openedBy,
    entryReason: p.reason,
    exitReason: reason,
    situation: p.situation,
  };
  const fill: Fill = { id: uid(), time: sold.time, symbol: p.symbol, action: 'sell', kind: 'close', qty: sold.qty, price: sold.avgPrice, by: p.openedBy };
  const s = get();
  lastExitAt = Date.now();
  set({
    cash,
    positions: s.positions.filter((x) => x.id !== p.id),
    trades: [...s.trades, trade].slice(-MAX_FILLS),
    fills: [...s.fills, fill].slice(-MAX_FILLS),
  });
  get().log('sell', `Sold ${sold.qty.toFixed(5)} BTC ${where()} at ${fmtPrice(sold.avgPrice)} for ${signedMoney(pnl)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%). ${reason}.`, SYMBOL);
  get().toast(pnl >= 0 ? 'good' : 'bad', `Sold BTC ${signedMoney(pnl)}: ${reason.toLowerCase()}`);
}

/** A stop that Binance filled: its order reports the gross USDT, so the usual fee is taken off. */
function stopFill(o: OrderStatus) {
  const fee = (o.quote * get().settings.feePct) / 100;
  return { qty: o.qty, quote: o.quote - fee, avgPrice: o.avgPrice, feeUsdt: fee, time: o.time };
}

/** Sells a real position: cancels its Binance stop, then sells at market. */
export async function closeReal(id: string, reason: string): Promise<void> {
  const p = find(id);
  if (!p?.real || closing.has(id)) return;
  closing.add(id);
  let stopCancelled = false;
  try {
    let partial: { qty: number; quote: number; avgPrice: number } | null = null;
    if (p.real.stopOrderId) {
      const c = await realApi.cancel(p.real.stopOrderId);
      if (!c.cancelled && c.order?.status === 'FILLED') {
        recordClose(p, stopFill(c.order), 'Stop loss hit on Binance', await freshCash());
        return;
      }
      stopCancelled = true;
      updatePosition(id, (x) => ({ ...x, real: { ...x.real!, stopOrderId: undefined } }));
      // A stop that partly filled before it was cancelled already sold some BTC.
      const o = c.order ?? (await realApi.order(p.real.stopOrderId));
      if (o.qty > 0) partial = { qty: o.qty, quote: stopFill(o).quote, avgPrice: o.avgPrice };
    }
    const sell = await realApi.sell(p.qty - (partial?.qty ?? 0));
    const qty = sell.qty + (partial?.qty ?? 0);
    const quote = sell.quote + (partial?.quote ?? 0);
    const avgPrice = partial ? (sell.avgPrice * sell.qty + partial.avgPrice * partial.qty) / qty : sell.avgPrice;
    recordClose(p, { qty, quote, avgPrice, feeUsdt: sell.feeUsdt + (partial ? partial.qty * partial.avgPrice - partial.quote : 0), time: sell.time }, reason, await freshCash());
  } catch (e) {
    get().log('warn', `Sell ${where()} failed: ${(e as Error).message}`, SYMBOL);
    get().toast('bad', `Sell failed: ${(e as Error).message}`);
    // Never leave real BTC without its stop loss.
    if (stopCancelled && find(id)) await placeStop(id);
  } finally {
    closing.delete(id);
  }
}

/** Checks Binance for stops that filled while the bot watched (or while the app was closed). */
export async function checkRealStops(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    await checkEach();
  } finally {
    checking = false;
  }
}

async function checkEach(): Promise<void> {
  for (const p of get().positions) {
    if (!p.real || closing.has(p.id)) continue;
    if (!p.real.stopOrderId) {
      if (p.stopLoss && get().tradingMode === p.real.env) await placeStop(p.id);
      continue;
    }
    try {
      const o = await realApi.order(p.real.stopOrderId);
      if (closing.has(p.id) || !find(p.id)) continue;
      if (o.status === 'FILLED') recordClose(p, stopFill(o), 'Stop loss hit on Binance', await freshCash());
      else if (o.status === 'CANCELED' || o.status === 'EXPIRED' || o.status === 'REJECTED') {
        get().log('warn', `Binance shows the stop loss as ${o.status.toLowerCase()}. Placing it again.`, SYMBOL);
        updatePosition(p.id, (x) => ({ ...x, real: { ...x.real!, stopOrderId: undefined } }));
        await placeStop(p.id);
      }
    } catch {
      // Offline or the server is busy: try again on the next check.
    }
  }
}
