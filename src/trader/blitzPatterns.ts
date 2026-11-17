import type { Candle } from '../types';
import { atr, ema } from '../lib/indicators';

/**
 * Blitz's chart reader: no points or scores. It reads the shape of the 1-minute chart (swing
 * highs and lows, ranges, spikes, the session's average price) and looks for patterns. Each
 * pattern says which way to trade and where the idea is proven wrong: that is the stop, so it
 * depends on the chart, not on a fixed percent. While a trade is open the stop follows the chart:
 * below each new higher low in an uptrend (above each new lower high in a downtrend).
 *
 * The same code runs in the research (scripts/blitz-patterns-research.ts) and in the app.
 */

export type BlitzPattern =
  | 'trend-pullback'
  | 'squeeze-breakout'
  | 'sweep-reversal'
  | 'spike-follow'
  | 'spike-fade'
  | 'range-breakout'
  | 'vwap-reclaim';

export const PATTERN_LABEL: Record<BlitzPattern, string> = {
  'trend-pullback': 'Pullback in a trend, bouncing back',
  'squeeze-breakout': 'Breakout from a tight, quiet range on high volume',
  'sweep-reversal': 'Stop hunt: price broke the last swing and snapped back',
  'spike-follow': 'Big candle on heavy volume, following it',
  'spike-fade': 'Big candle on heavy volume, betting it snaps back',
  'range-breakout': 'Breakout from the first 15 minutes of the session',
  'vwap-reclaim': "Price won back the session's average price",
};

export interface BlitzChart {
  atr: number[];
  ema20: number[];
  /** Average volume of the 20 candles before each one. */
  volAvg: number[];
  /** High and low of the 30 candles before each one (not including it). */
  hi30: number[];
  lo30: number[];
  /** Typical 30-candle range over the 4 hours before. */
  rangeAvg: number[];
  /** Latest two confirmed swing highs and lows (3 candles each side), as known at each candle. */
  swingHigh: number[];
  swingLow: number[];
  prevSwingHigh: number[];
  prevSwingLow: number[];
  /** Index of the candle the latest swing low / high was on. */
  swingLowAt: number[];
  swingHighAt: number[];
}

const SWING = 3;

/** Reads the whole chart once. Uses only candles up to each point, never later ones. */
export function readBlitzChart(bars: Candle[]): BlitzChart {
  const n = bars.length;
  const close = bars.map((b) => b.close);
  const a = atr(bars, 14);
  const e20 = ema(close, 20);
  const volAvg = new Array<number>(n).fill(NaN);
  const hi30 = new Array<number>(n).fill(NaN);
  const lo30 = new Array<number>(n).fill(NaN);
  const rangeAvg = new Array<number>(n).fill(NaN);
  let vsum = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 20) volAvg[i] = vsum / 20;
    vsum += bars[i].volume;
    if (i >= 20) vsum -= bars[i - 20].volume;
    if (i >= 30) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - 30; k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      hi30[i] = hi;
      lo30[i] = lo;
    }
    if (i >= 270) {
      let s = 0;
      for (let k = 1; k <= 8; k++) s += hi30[i - 30 * k] - lo30[i - 30 * k];
      rangeAvg[i] = s / 8;
    }
  }
  const swingHigh = new Array<number>(n).fill(NaN);
  const swingLow = new Array<number>(n).fill(NaN);
  const prevSwingHigh = new Array<number>(n).fill(NaN);
  const prevSwingLow = new Array<number>(n).fill(NaN);
  const swingLowAt = new Array<number>(n).fill(-1);
  const swingHighAt = new Array<number>(n).fill(-1);
  let sh = NaN, sl = NaN, psh = NaN, psl = NaN, shAt = -1, slAt = -1;
  for (let i = 0; i < n; i++) {
    const k = i - SWING; // a swing on candle k is confirmed once SWING candles have closed after it
    if (k >= SWING) {
      let isHigh = true;
      let isLow = true;
      for (let d = 1; d <= SWING; d++) {
        if (bars[k - d].high > bars[k].high || bars[k + d].high >= bars[k].high) isHigh = false;
        if (bars[k - d].low < bars[k].low || bars[k + d].low <= bars[k].low) isLow = false;
      }
      if (isHigh) {
        psh = sh;
        sh = bars[k].high;
        shAt = k;
      }
      if (isLow) {
        psl = sl;
        sl = bars[k].low;
        slAt = k;
      }
    }
    swingHigh[i] = sh;
    swingLow[i] = sl;
    prevSwingHigh[i] = psh;
    prevSwingLow[i] = psl;
    swingHighAt[i] = shAt;
    swingLowAt[i] = slAt;
  }
  return { atr: a, ema20: e20, volAvg, hi30, lo30, rangeAvg, swingHigh, swingLow, prevSwingHigh, prevSwingLow, swingLowAt, swingHighAt };
}

/** 1 when the swings make higher highs and higher lows, −1 for lower highs and lower lows, else 0. */
export function structure(c: BlitzChart, i: number): -1 | 0 | 1 {
  const up = c.swingHigh[i] > c.prevSwingHigh[i] && c.swingLow[i] > c.prevSwingLow[i];
  const down = c.swingHigh[i] < c.prevSwingHigh[i] && c.swingLow[i] < c.prevSwingLow[i];
  return up ? 1 : down ? -1 : 0;
}

export interface BlitzIdea {
  pattern: BlitzPattern;
  side: 'long' | 'short';
  /** Where the idea is proven wrong. */
  stop: number;
  reason: string;
}

/**
 * Looks at the candle that just closed (index i) for the given patterns. `sessionStart` is the
 * index of the session's first candle (for the first-15-minutes range and the session average).
 */
export function findBlitzIdea(bars: Candle[], c: BlitzChart, i: number, sessionStart: number, patterns: readonly BlitzPattern[]): BlitzIdea | null {
  const b = bars[i];
  const a = c.atr[i];
  if (!(a > 0) || !(c.volAvg[i] > 0) || i < 10) return null;
  const range = b.high - b.low;
  const body = b.close - b.open;
  const loud = b.volume > 2 * c.volAvg[i];
  const trend = structure(c, i);
  const out = (pattern: BlitzPattern, side: 'long' | 'short', stop: number, reason: string): BlitzIdea | null => {
    // A stop on the wrong side, or too close to mean anything, is no idea at all.
    const dist = side === 'long' ? b.close - stop : stop - b.close;
    if (!(dist > 0.3 * a)) return null;
    return { pattern, side, stop, reason };
  };

  for (const p of patterns) {
    let idea: BlitzIdea | null = null;
    if (p === 'trend-pullback' && trend !== 0) {
      // In an uptrend, price dipped to the 20-candle average in the last 3 candles and this candle
      // closed above the previous candle's high: the dip is being bought.
      const dir = trend;
      const touched = [1, 2, 3].some((k) => (dir > 0 ? bars[i - k].low <= c.ema20[i - k] + 0.2 * a : bars[i - k].high >= c.ema20[i - k] - 0.2 * a));
      const turned = dir > 0 ? b.close > bars[i - 1].high && body > 0 : b.close < bars[i - 1].low && body < 0;
      if (touched && turned) {
        const extreme = dir > 0 ? Math.min(...bars.slice(i - 5, i + 1).map((x) => x.low)) : Math.max(...bars.slice(i - 5, i + 1).map((x) => x.high));
        idea = out(p, dir > 0 ? 'long' : 'short', extreme - dir * 0.2 * a, `${dir > 0 ? 'Higher highs and higher lows' : 'Lower highs and lower lows'}, a pullback to the average, and a candle breaking back ${dir > 0 ? 'up' : 'down'}`);
      }
    } else if (p === 'squeeze-breakout' && c.rangeAvg[i] > 0) {
      const width = c.hi30[i] - c.lo30[i];
      if (width < 0.6 * c.rangeAvg[i] && loud) {
        const mid = (c.hi30[i] + c.lo30[i]) / 2;
        if (b.close > c.hi30[i]) idea = out(p, 'long', mid, `A quiet 30-minute range (${((width / b.close) * 100).toFixed(2)}% tall) broken upward on ${(b.volume / c.volAvg[i]).toFixed(1)}× volume`);
        else if (b.close < c.lo30[i]) idea = out(p, 'short', mid, `A quiet 30-minute range (${((width / b.close) * 100).toFixed(2)}% tall) broken downward on ${(b.volume / c.volAvg[i]).toFixed(1)}× volume`);
      }
    } else if (p === 'sweep-reversal') {
      // Price pushed below the last swing low (where stops sit), then closed back above it, near its high.
      const sl = c.swingLow[i];
      const sh = c.swingHigh[i];
      if (sl > 0 && b.low < sl && b.close > sl && b.close - b.low > 0.6 * range && b.volume > 1.3 * c.volAvg[i]) {
        idea = out(p, 'long', b.low - 0.1 * a, 'Price dipped under the last swing low and snapped back above it');
      } else if (sh > 0 && b.high > sh && b.close < sh && b.high - b.close > 0.6 * range && b.volume > 1.3 * c.volAvg[i]) {
        idea = out(p, 'short', b.high + 0.1 * a, 'Price poked over the last swing high and fell back below it');
      }
    } else if ((p === 'spike-follow' || p === 'spike-fade') && range > 3 * a && b.volume > 3 * c.volAvg[i]) {
      const strongUp = b.close - b.low > 0.75 * range;
      const strongDown = b.high - b.close > 0.75 * range;
      const mid = (b.high + b.low) / 2;
      if (p === 'spike-follow') {
        if (strongUp) idea = out(p, 'long', mid, `A candle ${(range / a).toFixed(1)}× the usual size on ${(b.volume / c.volAvg[i]).toFixed(1)}× volume, closing at its high`);
        else if (strongDown) idea = out(p, 'short', mid, `A candle ${(range / a).toFixed(1)}× the usual size on ${(b.volume / c.volAvg[i]).toFixed(1)}× volume, closing at its low`);
      } else {
        if (strongUp) idea = out(p, 'short', b.high + 0.3 * a, `A spike up ${(range / a).toFixed(1)}× the usual size: betting it snaps back`);
        else if (strongDown) idea = out(p, 'long', b.low - 0.3 * a, `A spike down ${(range / a).toFixed(1)}× the usual size: betting it snaps back`);
      }
    } else if (p === 'range-breakout' && i >= sessionStart + 15) {
      // The first 15 minutes of the session set a range; trade the first close outside it.
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = sessionStart; k < sessionStart + 15; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      const prevIn = bars[i - 1].close <= hi && bars[i - 1].close >= lo;
      if (prevIn && b.close > hi) idea = out(p, 'long', (hi + lo) / 2, 'Broke above the range of the session’s first 15 minutes');
      else if (prevIn && b.close < lo) idea = out(p, 'short', (hi + lo) / 2, 'Broke below the range of the session’s first 15 minutes');
    } else if (p === 'vwap-reclaim' && i >= sessionStart + 10) {
      // The session's volume-weighted average price, won back after 10 candles under it (or lost after 10 over it).
      let pv = 0;
      let v = 0;
      let below = 0;
      let above = 0;
      for (let k = sessionStart; k <= i; k++) {
        const typical = (bars[k].high + bars[k].low + bars[k].close) / 3;
        pv += typical * bars[k].volume;
        v += bars[k].volume;
        if (k >= i - 10 && k < i) {
          const vw = pv / v;
          if (bars[k].close < vw) below++;
          else above++;
        }
      }
      const vwap = pv / v;
      if (below >= 8 && b.close > vwap && body > 0) idea = out(p, 'long', Math.min(...bars.slice(i - 10, i + 1).map((x) => x.low)) - 0.1 * a, 'Won back the session’s average price after trading under it');
      else if (above >= 8 && b.close < vwap && body < 0) idea = out(p, 'short', Math.max(...bars.slice(i - 10, i + 1).map((x) => x.high)) + 0.1 * a, 'Lost the session’s average price after trading over it');
    }
    if (idea) return idea;
  }
  return null;
}

export type BlitzExit = 'structure' | 'chandelier';

/**
 * Moves an open trade's stop with the chart, never backwards. 'structure': under each new swing
 * low that formed after the entry (over each new swing high for a short), and to break-even once
 * the trade is up twice its risk. 'chandelier': 3 × the typical 1-minute move behind the best
 * price since the entry.
 */
export function trailBlitzStop(
  bars: Candle[],
  c: BlitzChart,
  i: number,
  t: { side: 'long' | 'short'; entry: number; entryAt: number; stop: number; risk: number; best: number },
  exit: BlitzExit,
): number {
  const a = c.atr[i];
  let stop = t.stop;
  if (exit === 'structure') {
    if (t.side === 'long') {
      if (c.swingLowAt[i] > t.entryAt) stop = Math.max(stop, c.swingLow[i] - 0.1 * a);
      if (t.best >= t.entry + 2 * t.risk) stop = Math.max(stop, t.entry * 1.0025);
    } else {
      if (c.swingHighAt[i] > t.entryAt) stop = Math.min(stop, c.swingHigh[i] + 0.1 * a);
      if (t.best <= t.entry - 2 * t.risk) stop = Math.min(stop, t.entry * 0.9975);
    }
  } else {
    stop = t.side === 'long' ? Math.max(stop, t.best - 3 * a) : Math.min(stop, t.best + 3 * a);
  }
  void bars;
  return stop;
}
