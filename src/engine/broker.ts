import type { Actor, Fill, Position, Side, Trade } from '../types';
import { uid } from '../lib/format';

/** Paper broker: pure functions over the account so they are easy to test. */

export interface Account {
  cash: number;
  positions: Position[];
}

export interface OpenRequest {
  symbol: string;
  side: Side;
  /** Dollars to commit (position notional). */
  amount: number;
  price: number;
  time: number;
  feePct: number;
  slippagePct: number;
  stopLossPct: number;
  takeProfitPct: number;
  by: Actor;
  reason: string;
  situation?: string;
  blitz?: boolean;
}

export type OpenResult = { ok: true; account: Account; position: Position; fill: Fill } | { ok: false; error: string };

export function openPosition(acc: Account, req: OpenRequest): OpenResult {
  if (!(req.price > 0)) return { ok: false, error: 'No price yet for this market' };
  if (!(req.amount > 0)) return { ok: false, error: 'Trade amount must be above $0' };
  if (acc.positions.some((p) => p.symbol === req.symbol)) return { ok: false, error: `Already holding ${req.symbol}` };

  const slip = req.slippagePct / 100;
  const fillPrice = req.side === 'long' ? req.price * (1 + slip) : req.price * (1 - slip);
  const fee = (req.amount * req.feePct) / 100;
  if (req.amount + fee > acc.cash + 1e-9) return { ok: false, error: 'Not enough cash for this trade' };

  const qty = req.amount / fillPrice;
  const dir = req.side === 'long' ? 1 : -1;
  const position: Position = {
    id: uid(),
    symbol: req.symbol,
    side: req.side,
    qty,
    entryPrice: fillPrice,
    entryTime: req.time,
    collateral: req.amount,
    entryFee: fee,
    stopLoss: req.stopLossPct > 0 ? fillPrice * (1 - (dir * req.stopLossPct) / 100) : null,
    takeProfit: req.takeProfitPct > 0 ? fillPrice * (1 + (dir * req.takeProfitPct) / 100) : null,
    peak: fillPrice,
    trailPct: req.stopLossPct > 0 ? req.stopLossPct : undefined,
    openedBy: req.by,
    reason: req.reason,
    ...(req.situation ? { situation: req.situation } : {}),
    ...(req.blitz ? { blitz: true } : {}),
  };
  const fill: Fill = {
    id: uid(),
    time: req.time,
    symbol: req.symbol,
    action: req.side === 'long' ? 'buy' : 'sell',
    kind: 'open',
    qty,
    price: fillPrice,
    by: req.by,
  };
  return { ok: true, account: { cash: acc.cash - req.amount - fee, positions: [...acc.positions, position] }, position, fill };
}

/** The chart price in the position's own market (Binance Testnet prices differ from the real market). */
export const markPrice = (p: Position, price: number) => price * (p.real?.priceRatio ?? 1);

/** Current value of a position, including the cash locked when it was opened. */
export function positionValue(p: Position, chartPrice: number): number {
  const price = markPrice(p, chartPrice);
  return p.side === 'long' ? p.qty * price : p.collateral + (p.entryPrice - price) * p.qty;
}

export function unrealized(p: Position, price: number): number {
  return positionValue(p, price) - p.collateral;
}

export function equity(acc: Account, prices: Record<string, number>): number {
  return acc.cash + acc.positions.reduce((s, p) => s + positionValue(p, prices[p.symbol] ?? p.entryPrice), 0);
}

export interface CloseRequest {
  positionId: string;
  price: number;
  time: number;
  feePct: number;
  slippagePct: number;
  reason: string;
}

export type CloseResult = { ok: true; account: Account; trade: Trade; fill: Fill } | { ok: false; error: string };

export function closePosition(acc: Account, req: CloseRequest): CloseResult {
  const p = acc.positions.find((x) => x.id === req.positionId);
  if (!p) return { ok: false, error: 'Position is already closed' };
  if (!(req.price > 0)) return { ok: false, error: 'No price yet for this market' };

  const slip = req.slippagePct / 100;
  const exitPrice = p.side === 'long' ? req.price * (1 - slip) : req.price * (1 + slip);
  const value = positionValue(p, exitPrice);
  const exitFee = ((p.qty * exitPrice) * req.feePct) / 100;
  const pnl = value - p.collateral - p.entryFee - exitFee;

  const trade: Trade = {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    entryPrice: p.entryPrice,
    exitPrice,
    entryTime: p.entryTime,
    exitTime: req.time,
    pnl,
    pnlPct: (pnl / p.collateral) * 100,
    fees: p.entryFee + exitFee,
    openedBy: p.openedBy,
    entryReason: p.reason,
    exitReason: req.reason,
    situation: p.situation,
    ...(p.blitz ? { blitz: true } : {}),
  };
  const fill: Fill = {
    id: uid(),
    time: req.time,
    symbol: p.symbol,
    action: p.side === 'long' ? 'sell' : 'buy',
    kind: 'close',
    qty: p.qty,
    price: exitPrice,
    by: p.openedBy,
  };
  return {
    ok: true,
    account: { cash: acc.cash + value - exitFee, positions: acc.positions.filter((x) => x.id !== p.id) },
    trade,
    fill,
  };
}

/** Checks a price against a position's stop loss and take profit. Returns the exit reason, or null. */
export function protectiveExit(p: Position, chartPrice: number): { reason: string; level: number } | null {
  const price = markPrice(p, chartPrice);
  if (p.side === 'long') {
    if (p.stopLoss !== null && price <= p.stopLoss) return { reason: p.stopLoss > p.entryPrice ? 'Trailing stop hit (profit locked)' : 'Stop loss hit', level: p.stopLoss };
    if (p.takeProfit !== null && price >= p.takeProfit) return { reason: 'Take profit hit', level: p.takeProfit };
  } else {
    if (p.stopLoss !== null && price >= p.stopLoss) return { reason: p.stopLoss < p.entryPrice ? 'Trailing stop hit (profit locked)' : 'Stop loss hit', level: p.stopLoss };
    if (p.takeProfit !== null && price <= p.takeProfit) return { reason: 'Take profit hit', level: p.takeProfit };
  }
  return null;
}

/** Ratchets the stop behind the best price. Returns null when nothing changed. */
export function trail(p: Position, price: number, stopLossPct: number): Pick<Position, 'peak' | 'stopLoss'> | null {
  if (stopLossPct <= 0) return null;
  const better = p.side === 'long' ? price > p.peak : price < p.peak;
  if (!better) return null;
  const peak = price;
  const candidate = p.side === 'long' ? peak * (1 - stopLossPct / 100) : peak * (1 + stopLossPct / 100);
  const current = p.stopLoss;
  const improves = current === null || (p.side === 'long' ? candidate > current : candidate < current);
  return { peak, stopLoss: improves ? candidate : current };
}

export interface AdjustRequest {
  symbol: string;
  side: Side;
  /** Target position size in dollars at the current price; 0 closes the position. */
  notional: number;
  price: number;
  time: number;
  feePct: number;
  slippagePct: number;
  by: Actor;
  reason: string;
}

export interface AdjustResult {
  account: Account;
  fills: Fill[];
  /** Round trips realised by closing all or part of a position. */
  trades: Trade[];
}

/**
 * Moves a market's position to a target size: opens, adds to, trims, flips or closes it.
 * Trimming realises profit or loss on the part sold, at the position's average entry price.
 */
export function adjustPosition(acc: Account, req: AdjustRequest): AdjustResult {
  const fills: Fill[] = [];
  const trades: Trade[] = [];
  let account = acc;
  const current = () => account.positions.find((p) => p.symbol === req.symbol);
  const closeAll = (reason: string) => {
    const p = current();
    if (!p) return;
    const r = closePosition(account, { positionId: p.id, price: req.price, time: req.time, feePct: req.feePct, slippagePct: req.slippagePct, reason });
    if (r.ok) {
      account = r.account;
      fills.push(r.fill);
      trades.push(r.trade);
    }
  };

  let p = current();
  if (p && (req.notional <= 0 || p.side !== req.side)) {
    closeAll(req.notional <= 0 ? req.reason : `${req.reason} (switching to ${req.side})`);
    p = undefined;
  }
  if (req.notional <= 0) return { account, fills, trades };

  if (!p) {
    const amount = Math.min(req.notional, account.cash / (1 + req.feePct / 100));
    const r = openPosition(account, { ...req, amount, stopLossPct: 0, takeProfitPct: 0 });
    if (r.ok) {
      account = r.account;
      fills.push(r.fill);
    }
    return { account, fills, trades };
  }

  const slip = req.slippagePct / 100;
  const fee = req.feePct / 100;
  const held = p.qty * req.price;
  const delta = req.notional - held;
  if (delta > 0) {
    // Add to the position at the current price; the entry price becomes the average.
    const amount = Math.min(delta, account.cash / (1 + fee));
    if (amount < 1) return { account, fills, trades };
    const fillPrice = p.side === 'long' ? req.price * (1 + slip) : req.price * (1 - slip);
    const qty = amount / fillPrice;
    const f = amount * fee;
    const next: Position = { ...p, qty: p.qty + qty, collateral: p.collateral + amount, entryFee: p.entryFee + f };
    next.entryPrice = next.collateral / next.qty;
    account = { cash: account.cash - amount - f, positions: account.positions.map((x) => (x.id === p!.id ? next : x)) };
    fills.push({ id: uid(), time: req.time, symbol: req.symbol, action: p.side === 'long' ? 'buy' : 'sell', kind: 'open', qty, price: fillPrice, by: req.by });
  } else if (delta < 0) {
    // Trim: sell part of the position and realise its share of the profit or loss.
    const qty = Math.min(p.qty, -delta / req.price);
    if (qty * req.price < 1) return { account, fills, trades };
    if (qty >= p.qty * 0.999) {
      closeAll(req.reason);
      return { account, fills, trades };
    }
    const share = qty / p.qty;
    const fillPrice = p.side === 'long' ? req.price * (1 - slip) : req.price * (1 + slip);
    const released = p.collateral * share;
    const value = p.side === 'long' ? qty * fillPrice : released + (p.entryPrice - fillPrice) * qty;
    const exitFee = qty * fillPrice * fee;
    const entryFee = p.entryFee * share;
    const pnl = value - released - entryFee - exitFee;
    const next: Position = { ...p, qty: p.qty - qty, collateral: p.collateral - released, entryFee: p.entryFee - entryFee };
    account = { cash: account.cash + value - exitFee, positions: account.positions.map((x) => (x.id === p!.id ? next : x)) };
    fills.push({ id: uid(), time: req.time, symbol: req.symbol, action: p.side === 'long' ? 'sell' : 'buy', kind: 'close', qty, price: fillPrice, by: req.by });
    trades.push({
      id: uid(),
      symbol: req.symbol,
      side: p.side,
      qty,
      entryPrice: p.entryPrice,
      exitPrice: fillPrice,
      entryTime: p.entryTime,
      exitTime: req.time,
      pnl,
      pnlPct: (pnl / released) * 100,
      fees: entryFee + exitFee,
      openedBy: p.openedBy,
      entryReason: p.reason,
      exitReason: `${req.reason} (trimmed ${(share * 100).toFixed(0)}%)`,
    });
  }
  return { account, fills, trades };
}
