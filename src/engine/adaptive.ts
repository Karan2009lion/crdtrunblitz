import type { Candle, Side } from '../types';
import { lowerBound } from './backtest';

/**
 * Adaptive mode: the bot learns from its mistakes by shadow-trading many candidate settings
 * on the same prices, then periodically following whichever candidates have done best
 * recently and dropping the ones that have been losing. When nothing has been working,
 * it waits in cash. Every choice uses only data from before the moment it is made.
 */

export const DAY = 86_400;

/** A candidate's trades from its own shadow account, as [entryTime, exitTime, side, entryPrice, exitPrice]. */
export type ShadowTrade = [number, number, 1 | -1, number, number];

export interface ShadowRun {
  id: number;
  /** Shadow account value at the end of each UTC day, starting at `dayStart`. */
  daily: number[];
  /** Trades in time order; times are unix seconds. */
  trades: ShadowTrade[];
}

export interface AdaptiveOptions {
  /** How far back to judge candidates, in days. */
  windowDays: number;
  /** How often to re-choose, in days. */
  rebalanceDays: number;
  /** How many candidates to follow at once; capital is split between them. */
  topK: number;
  /** Score = return % − ddPenalty × biggest drop % over the window. */
  ddPenalty: number;
  /** Candidates need at least this many closed trades in the window to be chosen. */
  minTrades: number;
  startCash: number;
  feePct: number;
  slippagePct: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveOptions = {
  windowDays: 60,
  rebalanceDays: 7,
  topK: 3,
  ddPenalty: 0.5,
  minTrades: 3,
  startCash: 10_000,
  feePct: 0.1,
  slippagePct: 0.02,
};

export interface AdaptiveChoice {
  time: number;
  /** Candidate ids per slot; -1 means the slot waits in cash. */
  picks: number[];
  scores: number[];
}

export interface AdaptiveTrade {
  slot: number;
  candidate: number;
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  fees: number;
  /** True when the bot closed it early because it switched candidates. */
  switched: boolean;
}

export interface AdaptiveResult {
  equity: { time: number; value: number }[];
  trades: AdaptiveTrade[];
  choices: AdaptiveChoice[];
  stats: { startCash: number; endEquity: number; returnPct: number; maxDrawdownPct: number; trades: number; wins: number; fees: number; switches: number };
}

/** Return % and biggest drop % of a candidate's shadow account over [fromDay, toDay]. */
export function windowScore(run: ShadowRun, fromDay: number, toDay: number) {
  const a = Math.max(0, fromDay);
  const b = Math.min(run.daily.length - 1, toDay);
  if (b <= a) return { ret: 0, dd: 0 };
  let peak = run.daily[a];
  let dd = 0;
  for (let i = a; i <= b; i++) {
    peak = Math.max(peak, run.daily[i]);
    dd = Math.max(dd, peak > 0 ? ((peak - run.daily[i]) / peak) * 100 : 0);
  }
  const ret = run.daily[a] > 0 ? ((run.daily[b] - run.daily[a]) / run.daily[a]) * 100 : -100;
  return { ret, dd };
}

function closedTradesBetween(run: ShadowRun, t0: number, t1: number) {
  let n = 0;
  for (const t of run.trades) if (t[1] > t0 && t[1] <= t1) n++;
  return n;
}

/** Ranks candidates on the window ending at `time`. Returns the best ids with positive scores. */
export function choose(runs: ShadowRun[], dayStart: number, time: number, o: AdaptiveOptions): { id: number; score: number }[] {
  const toDay = Math.floor((time - dayStart) / DAY) - 1; // last fully finished day
  const fromDay = toDay - o.windowDays;
  if (fromDay < 0) return [];
  const scored: { id: number; score: number }[] = [];
  for (const r of runs) {
    if (closedTradesBetween(r, time - o.windowDays * DAY, time) < o.minTrades) continue;
    const { ret, dd } = windowScore(r, fromDay, toDay);
    const score = ret - o.ddPenalty * dd;
    if (score > 0) scored.push({ id: r.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, o.topK);
}

interface Slot {
  cash: number;
  candidate: number;
  /** Copied open position. */
  pos: { side: 1 | -1; qty: number; entryTime: number; entryPrice: number; exitTime: number; exitPrice: number; fee: number } | null;
  /** Index of the next candidate trade to look at. */
  next: number;
}

/**
 * Follows the chosen candidates from `start` to `end`, copying their trades into the bot's
 * own account. Switching candidates closes any copied position at the current price.
 */
export function simulateAdaptive(base: Candle[], runs: ShadowRun[], dayStart: number, start: number, end: number, o: AdaptiveOptions): AdaptiveResult {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const priceAt = (t: number) => {
    const i = Math.min(base.length - 1, Math.max(0, lowerBound(base, t) - 1));
    return base[i].close;
  };
  const fee = o.feePct / 100;
  const slip = o.slippagePct / 100;
  const slots: Slot[] = Array.from({ length: o.topK }, () => ({ cash: o.startCash / o.topK, candidate: -1, pos: null, next: 0 }));
  const trades: AdaptiveTrade[] = [];
  const choices: AdaptiveChoice[] = [];
  const equity: { time: number; value: number }[] = [];
  let switches = 0;

  const value = (s: Slot, t: number) => {
    if (!s.pos) return s.cash;
    const px = priceAt(t);
    return s.cash + s.pos.qty * s.pos.entryPrice + s.pos.side * s.pos.qty * (px - s.pos.entryPrice);
  };
  const settle = (s: Slot, slot: number, exitTime: number, exitPrice: number, switched: boolean) => {
    const p = s.pos!;
    const exitFee = p.qty * exitPrice * fee;
    const pnl = p.side * p.qty * (exitPrice - p.entryPrice) - p.fee - exitFee;
    s.cash += p.qty * p.entryPrice + p.side * p.qty * (exitPrice - p.entryPrice) - exitFee;
    trades.push({ slot, candidate: s.candidate, side: p.side === 1 ? 'long' : 'short', entryTime: p.entryTime, exitTime, entryPrice: p.entryPrice, exitPrice, pnl, fees: p.fee + exitFee, switched });
    s.pos = null;
  };
  const enter = (s: Slot, side: 1 | -1, time: number, price: number, exitTime: number, exitPrice: number) => {
    const notional = Math.max(0, s.cash / (1 + fee));
    if (notional < 1) return;
    const qty = notional / price;
    const f = notional * fee;
    s.cash -= notional + f;
    s.pos = { side, qty, entryTime: time, entryPrice: price, exitTime, exitPrice, fee: f };
  };
  /** Copies the candidate's trades up to time t (exclusive of new entries at t). */
  const advance = (s: Slot, slot: number, t: number) => {
    if (s.candidate < 0) return;
    const run = byId.get(s.candidate)!;
    for (;;) {
      if (s.pos && s.pos.exitTime <= t) {
        settle(s, slot, s.pos.exitTime, s.pos.exitPrice, false);
        continue;
      }
      if (s.pos) return;
      const tr = run.trades[s.next];
      if (!tr || tr[0] >= t) return;
      s.next++;
      enter(s, tr[2], tr[0], tr[3], tr[1], tr[4]);
    }
  };

  let nextRebalance = start;
  for (let day = Math.floor(start / DAY) * DAY + DAY; ; day += DAY) {
    const t = Math.min(day, end);
    // Rebalances due before this day boundary.
    while (nextRebalance < t) {
      const rt = nextRebalance;
      slots.forEach((s, i) => advance(s, i, rt));
      const best = choose(runs, dayStart, rt, o);
      const keep = new Set(best.map((b) => b.id));
      const picks: number[] = slots.map((s) => (keep.has(s.candidate) ? s.candidate : -1));
      const free = best.filter((b) => !picks.includes(b.id)).map((b) => b.id);
      slots.forEach((s, i) => {
        if (picks[i] === -1 && free.length) picks[i] = free.shift()!;
        if (picks[i] === s.candidate) return;
        switches++;
        if (s.pos) settle(s, i, rt, priceAt(rt) * (1 - s.pos.side * slip), true);
        s.candidate = picks[i];
        if (s.candidate < 0) return;
        const run = byId.get(s.candidate)!;
        // Join the candidate where it is now: copy an open trade at today's price.
        let k = 0;
        while (k < run.trades.length && run.trades[k][1] <= rt) k++;
        s.next = k;
        const tr = run.trades[k];
        if (tr && tr[0] < rt && tr[1] > rt) {
          s.next = k + 1;
          enter(s, tr[2], rt, priceAt(rt) * (1 + tr[2] * slip), tr[1], tr[4]);
        }
      });
      choices.push({ time: rt, picks: [...picks], scores: picks.map((id) => best.find((b) => b.id === id)?.score ?? 0) });
      nextRebalance += o.rebalanceDays * DAY;
    }
    slots.forEach((s, i) => advance(s, i, t));
    equity.push({ time: t, value: slots.reduce((sum, s) => sum + value(s, t), 0) });
    if (t >= end) break;
  }
  // Close what is still open at the end so the result is realised.
  slots.forEach((s, i) => s.pos && settle(s, i, end, priceAt(end), true));
  const endEquity = slots.reduce((sum, s) => sum + s.cash, 0);
  equity.push({ time: end, value: endEquity });

  let peak = o.startCash;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    maxDd = Math.max(maxDd, ((peak - p.value) / peak) * 100);
  }
  return {
    equity,
    trades,
    choices,
    stats: {
      startCash: o.startCash,
      endEquity,
      returnPct: ((endEquity - o.startCash) / o.startCash) * 100,
      maxDrawdownPct: maxDd,
      trades: trades.length,
      wins: trades.filter((t) => t.pnl > 0).length,
      fees: trades.reduce((s, t) => s + t.fees, 0),
      switches,
    },
  };
}
