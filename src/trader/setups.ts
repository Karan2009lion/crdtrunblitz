import type { Candle } from '../types';
import { aggregate } from '../engine/backtest';
import { atr, bollinger, ema, macd, rsi } from '../lib/indicators';

/**
 * The trader's eyes: every 5 minutes it looks at the chart for three classic setups, in both
 * directions, and proposes trades with a stop at a sensible place on the chart and a target at
 * twice the risk. Whether a proposal is taken is up to the learner (learner.ts).
 */

export type SetupId = 'pullback' | 'breakout' | 'reversal' | 'momentum';
export const SETUPS: SetupId[] = ['pullback', 'breakout', 'reversal', 'momentum'];
export const SETUP_LABEL: Record<SetupId, string> = {
  pullback: 'pullback in a trend',
  breakout: 'breakout from the range',
  reversal: 'reversal at an extreme',
  momentum: 'momentum turn',
};

export interface TraderOptions {
  barSec: number;
  targetR: number;
  maxHoldMin: number;
  minStopPct: number;
  maxStopPct: number;
  lookback: number;
}

export const TRADER: TraderOptions = {
  /** Setups are read on 5-minute candles; exits are checked every minute. */
  barSec: 300,
  /** Target as a multiple of the risk (distance to the stop). */
  targetR: 2,
  /** A trade still open after this long is closed. */
  maxHoldMin: 8 * 60,
  /** Stops closer than this are noise; farther than this risk too much. */
  minStopPct: 0.3,
  maxStopPct: 2.5,
  /** Candles of 1-minute history the trader reads (about 2 days). */
  lookback: 3000,
};

export interface Candidate {
  setup: SetupId;
  side: 'long' | 'short';
  /** Unix seconds when the 5-minute candle closed and the setup was seen. */
  time: number;
  entry: number;
  stop: number;
  target: number;
  /** What the chart looked like, for the learner (see FEATURE_NAMES). */
  features: number[];
}

export const FEATURE_NAMES = [
  'Setup: pullback',
  'Setup: breakout',
  'Setup: reversal',
  'Setup: momentum',
  'Direction (long +1, short −1)',
  'Short trend (20 vs 50 avg)',
  'Main trend (50 vs 200 avg)',
  'Price vs 200 avg',
  'Move over 1 hour',
  'Move over 4 hours',
  'Move over 24 hours',
  'RSI',
  'Place in Bollinger band',
  'Volume vs usual',
  'Volatility vs usual',
  'Stop distance',
  'Hour of day (sine)',
  'Hour of day (cosine)',
] as const;
export const FEATURE_COUNT = FEATURE_NAMES.length;

const clip = (v: number, lim = 5) => (Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);

/**
 * Looks at the last closed 5-minute candle of `m1` (1-minute candles, oldest first; the last one
 * must be closed) and returns any setups it shows. Uses only these candles, never later ones.
 */
export function findCandidates(m1: Candle[], opt: TraderOptions = TRADER): Candidate[] {
  const last = m1[m1.length - 1];
  if (!last || (last.time + 60) % opt.barSec !== 0) return []; // only when a strategy candle closes
  const bars = aggregate(m1.slice(-opt.lookback), opt.barSec);
  const n = bars.length - 1;
  if (n < 260 || bars[n].time + opt.barSec !== last.time + 60) return [];
  const close = bars.map((b) => b.close);
  const e20 = ema(close, 20);
  const e50 = ema(close, 50);
  const e200 = ema(close, 200);
  const r = rsi(close, 14);
  const bb = bollinger(close, 20, 2.5);
  const a = atr(bars, 14);
  const hist = macd(close).hist;
  const b = bars[n];
  const px = b.close;
  const atrPct = a[n] / px;
  if (!(atrPct > 0)) return [];

  let volAvg = 0;
  let atrAvg = 0;
  for (let k = n - 287; k <= n; k++) {
    volAvg += bars[k].volume / 288;
    atrAvg += (Number.isFinite(a[k]) ? a[k] / bars[k].close : atrPct) / 288;
  }
  const hi24 = Math.max(...bars.slice(n - 24, n).map((x) => x.high)); // the 2 hours before this candle
  const lo24 = Math.min(...bars.slice(n - 24, n).map((x) => x.low));
  const swingLo = Math.min(...bars.slice(n - 5, n + 1).map((x) => x.low));
  const swingHi = Math.max(...bars.slice(n - 5, n + 1).map((x) => x.high));
  const up = e20[n] > e50[n] && e50[n] > e200[n];
  const down = e20[n] < e50[n] && e50[n] < e200[n];
  const touchedUp = bars.slice(n - 3, n + 1).some((x) => x.low <= e20[n - 1] * 1.0005);
  const touchedDown = bars.slice(n - 3, n + 1).some((x) => x.high >= e20[n - 1] * 0.9995);
  const green = b.close > b.open;
  const red = b.close < b.open;
  const loud = b.volume > 1.5 * volAvg;

  const found: { setup: SetupId; side: 'long' | 'short'; stop: number }[] = [];
  if (up && touchedUp && green && px > e20[n]) found.push({ setup: 'pullback', side: 'long', stop: swingLo - 0.2 * a[n] });
  if (down && touchedDown && red && px < e20[n]) found.push({ setup: 'pullback', side: 'short', stop: swingHi + 0.2 * a[n] });
  if (px > hi24 && loud) found.push({ setup: 'breakout', side: 'long', stop: Math.min(hi24, px) - 1.0 * a[n] });
  if (px < lo24 && loud) found.push({ setup: 'breakout', side: 'short', stop: Math.max(lo24, px) + 1.0 * a[n] });
  const prev = bars[n - 1];
  if (r[n - 1] < 25 && prev.close < bb.lower[n - 1] && green) found.push({ setup: 'reversal', side: 'long', stop: Math.min(prev.low, b.low) - 0.5 * a[n] });
  if (r[n - 1] > 75 && prev.close > bb.upper[n - 1] && red) found.push({ setup: 'reversal', side: 'short', stop: Math.max(prev.high, b.high) + 0.5 * a[n] });
  if (hist[n - 1] <= 0 && hist[n] > 0) found.push({ setup: 'momentum', side: 'long', stop: px - 2.5 * a[n] });
  if (hist[n - 1] >= 0 && hist[n] < 0) found.push({ setup: 'momentum', side: 'short', stop: px + 2.5 * a[n] });

  const hour = new Date((last.time + 60) * 1000).getUTCHours() + new Date((last.time + 60) * 1000).getUTCMinutes() / 60;
  const ret = (k: number) => clip(Math.log(px / close[n - k]) / (atrPct * Math.sqrt(k)));
  const out: Candidate[] = [];
  for (const f of found) {
    const dir = f.side === 'long' ? 1 : -1;
    let stopPct = (dir * (px - f.stop)) / px * 100;
    // Keep the stop where the chart says, within sensible limits.
    stopPct = Math.min(opt.maxStopPct, Math.max(opt.minStopPct, stopPct));
    const stop = px * (1 - (dir * stopPct) / 100);
    const target = px * (1 + (dir * stopPct * opt.targetR) / 100);
    const features = [
      f.setup === 'pullback' ? 1 : 0,
      f.setup === 'breakout' ? 1 : 0,
      f.setup === 'reversal' ? 1 : 0,
      f.setup === 'momentum' ? 1 : 0,
      dir,
      clip(((e20[n] / e50[n] - 1) / atrPct) * dir),
      clip(((e50[n] / e200[n] - 1) / atrPct) * dir),
      clip(((px / e200[n] - 1) / atrPct) * dir),
      ret(12) * dir,
      ret(48) * dir,
      ret(288) * dir,
      ((r[n] - 50) / 50) * dir,
      clip((((px - bb.lower[n]) / (bb.upper[n] - bb.lower[n] || 1)) * 2 - 1) * dir, 3),
      clip(Math.log((b.volume + 1e-9) / (volAvg + 1e-9)), 3),
      clip(Math.log(atrPct / (atrAvg || atrPct)), 3),
      clip(stopPct / 100 / atrPct, 10),
      Math.sin((hour / 24) * 2 * Math.PI),
      Math.cos((hour / 24) * 2 * Math.PI),
    ];
    out.push({ setup: f.setup, side: f.side, time: last.time + 60, entry: px, stop, target, features });
  }
  return out;
}

export interface Outcome {
  result: 'target' | 'stop' | 'time';
  exit: number;
  /** Unix seconds. */
  time: number;
  /** Result in units of risk, after fees: +2 at the target, about −1 at the stop. */
  r: number;
}

/**
 * Follows a setup minute by minute. Returns its outcome once the stop, the target or the time
 * limit is reached, else null. If one minute touches both, the stop is assumed (pessimistic).
 * `costPct` is the round-trip cost (fees and slippage) in percent of the trade.
 */
export function resolveStep(c: Candidate, m: Candle, costPct: number, maxHoldMin = TRADER.maxHoldMin): Outcome | null {
  if (m.time + 60 <= c.time) return null;
  const long = c.side === 'long';
  const riskFrac = Math.abs(c.entry - c.stop) / c.entry;
  const rOf = (exit: number) => ((long ? exit / c.entry - 1 : 1 - exit / c.entry) - costPct / 100) / riskFrac;
  const hitStop = long ? m.low <= c.stop : m.high >= c.stop;
  if (hitStop) {
    const exit = long ? Math.min(m.open, c.stop) : Math.max(m.open, c.stop);
    return { result: 'stop', exit, time: m.time + 60, r: rOf(exit) };
  }
  const hitTarget = long ? m.high >= c.target : m.low <= c.target;
  if (hitTarget) {
    const exit = long ? Math.max(m.open, c.target) : Math.min(m.open, c.target);
    return { result: 'target', exit, time: m.time + 60, r: rOf(exit) };
  }
  if (m.time + 60 - c.time >= maxHoldMin * 60) return { result: 'time', exit: m.close, time: m.time + 60, r: rOf(m.close) };
  return null;
}
