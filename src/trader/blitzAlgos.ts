import type { Candle } from '../types';
import { atr, bollinger, ema, rsi } from '../lib/indicators';

/**
 * Blitz algorithms that trade often. Each one says, at every closed 1-minute candle, which way the
 * bot should be: long, short or out. The bot then buys, sells short, closes or flips to match,
 * with a safety stop. No points or scores: each reads a different property of the chart.
 *
 * The same code runs in the research (scripts/blitz-algos-research.ts) and in the app.
 */

export type BlitzAlgo = 'supertrend' | 'hull-turns' | 'regime-switch' | 'pressure' | 'snap-back';

export const ALGO_LABEL: Record<BlitzAlgo, string> = {
  supertrend: 'Trend switch: flips between buying and selling short when its trend line is crossed; after a stop-out it waits for a real flip',
  'hull-turns': 'Smooth-trend turns: follows each turn of a fast, low-lag average',
  'regime-switch': 'Regime switch: follows breakouts when trending, fades stretches when choppy',
  pressure: 'Buy/sell pressure: follows sudden surges of buying or selling volume',
  'snap-back': 'Snap-back: fades sharp stretches past the bands, out at the average',
};

export interface AlgoChart {
  atr: number[];
  stLine: number[];
  stDir: number[];
  hull: number[];
  er: number[];
  bbUpper: number[];
  bbLower: number[];
  bbMid: number[];
  rsi7: number[];
  hi20: number[];
  lo20: number[];
  pressureZ: number[];
}

function wma(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < v.length; i++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += v[i - k] * (n - k);
    out[i] = s / denom;
  }
  return out;
}

/** Reads the chart once; every value uses only candles up to that point. */
export function readAlgoChart(bars: Candle[], trendWidth = 3): AlgoChart {
  const n = bars.length;
  const close = bars.map((b) => b.close);
  const a = atr(bars, 10);
  // Supertrend (10, 3): a line 3 typical moves away that only ever moves in the trend's favour.
  const stLine = new Array<number>(n).fill(NaN);
  const stDir = new Array<number>(n).fill(0);
  let upper = NaN;
  let lower = NaN;
  let dir = 1;
  for (let i = 0; i < n; i++) {
    if (!(a[i] > 0)) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const bu = mid + trendWidth * a[i];
    const bl = mid - trendWidth * a[i];
    upper = Number.isNaN(upper) || bu < upper || bars[i - 1]?.close > upper ? bu : upper;
    lower = Number.isNaN(lower) || bl > lower || bars[i - 1]?.close < lower ? bl : lower;
    if (dir === 1 && close[i] < lower) dir = -1;
    else if (dir === -1 && close[i] > upper) dir = 1;
    stDir[i] = dir;
    stLine[i] = dir === 1 ? lower : upper;
  }
  // Hull moving average (30): fast and smooth.
  const half = wma(close, 15);
  const full = wma(close, 30);
  const raw = close.map((_, i) => 2 * half[i] - full[i]);
  const hull = new Array<number>(n).fill(NaN);
  const firstRaw = raw.findIndex((x) => Number.isFinite(x));
  if (firstRaw >= 0) {
    const w = wma(raw.slice(firstRaw), 5);
    for (let i = 0; i < w.length; i++) hull[firstRaw + i] = w[i];
  }
  // Efficiency ratio (30): how straight the last 30 minutes were (1 = a straight line, 0 = all noise).
  const er = new Array<number>(n).fill(NaN);
  for (let i = 30; i < n; i++) {
    let path = 0;
    for (let k = i - 29; k <= i; k++) path += Math.abs(close[k] - close[k - 1]);
    er[i] = path > 0 ? Math.abs(close[i] - close[i - 30]) / path : 0;
  }
  const bb = bollinger(close, 20, 2);
  const r7 = rsi(close, 7);
  const hi20 = new Array<number>(n).fill(NaN);
  const lo20 = new Array<number>(n).fill(NaN);
  for (let i = 20; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - 20; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }
    hi20[i] = hi;
    lo20[i] = lo;
  }
  // Buy/sell pressure: volume on up candles minus volume on down candles over 10 minutes,
  // compared with how it usually swings over the last 2 hours.
  const flow = bars.map((b) => Math.sign(b.close - b.open) * b.volume);
  const p10 = new Array<number>(n).fill(0);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += flow[i];
    if (i >= 10) run -= flow[i - 10];
    p10[i] = run;
  }
  const pressureZ = new Array<number>(n).fill(NaN);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s1 += p10[i];
    s2 += p10[i] * p10[i];
    if (i >= 120) {
      s1 -= p10[i - 120];
      s2 -= p10[i - 120] * p10[i - 120];
      const mean = s1 / 120;
      const sd = Math.sqrt(Math.max(1e-12, s2 / 120 - mean * mean));
      pressureZ[i] = (p10[i] - mean) / sd;
    }
  }
  return { atr: a, stLine, stDir, hull, er, bbUpper: bb.upper, bbLower: bb.lower, bbMid: bb.mid, rsi7: r7, hi20, lo20, pressureZ };
}

export type Want = 1 | -1 | 0;

/**
 * Which way the algorithm wants to be after candle i closes, given where it is now (`held`).
 * Returning `held` means keep what you have.
 */
export function algoWant(algo: BlitzAlgo, bars: Candle[], c: AlgoChart, i: number, held: Want): Want {
  const px = bars[i].close;
  if (!(c.atr[i] > 0)) return held;
  switch (algo) {
    case 'supertrend':
      return c.stDir[i] === 1 ? 1 : -1;
    case 'hull-turns': {
      const up = c.hull[i] > c.hull[i - 1] && c.hull[i - 1] <= c.hull[i - 2];
      const down = c.hull[i] < c.hull[i - 1] && c.hull[i - 1] >= c.hull[i - 2];
      return up ? 1 : down ? -1 : held;
    }
    case 'regime-switch': {
      if (c.er[i] >= 0.35) {
        if (px > c.hi20[i]) return 1;
        if (px < c.lo20[i]) return -1;
        return held;
      }
      if (c.er[i] <= 0.2) {
        if (held === 1 && px >= c.bbMid[i]) return 0;
        if (held === -1 && px <= c.bbMid[i]) return 0;
        if (held === 0 && px < c.bbLower[i]) return 1;
        if (held === 0 && px > c.bbUpper[i]) return -1;
      }
      return held;
    }
    case 'pressure': {
      const z = c.pressureZ[i];
      if (z > 2) return 1;
      if (z < -2) return -1;
      if (held === 1 && z < 0) return 0;
      if (held === -1 && z > 0) return 0;
      return held;
    }
    case 'snap-back': {
      if (held === 1 && px >= c.bbMid[i]) return 0;
      if (held === -1 && px <= c.bbMid[i]) return 0;
      if (held === 0 && px < c.bbLower[i] && c.rsi7[i] < 20) return 1;
      if (held === 0 && px > c.bbUpper[i] && c.rsi7[i] > 80) return -1;
      return held;
    }
  }
}

/**
 * Options for the trend switch. `room`: the stop stays at least this many typical 1-minute moves
 * from the price, even when the trend line is closer (right after a flip it often is, and normal
 * wiggles then stop the trade out within minutes). `waitForFlip`: after a stop-out, don't go
 * straight back in the same direction; wait until the trend line flips.
 */
export interface AlgoOptions {
  room?: number;
  waitForFlip?: boolean;
}
/**
 * The trend switch as Blitz runs it: the trend line 5 typical moves from the price, the stop at
 * least 1.5 typical moves away, and no re-entry after a stop-out until the line flips. In testing
 * this lost about $0.17 a 2-hour session with $30 trades, against $0.40 for the first version
 * (scripts/blitz-algos-research.ts with TREND_FIX=1 and WIDTHS=3,4,5,6).
 */
export const TREND_SWITCH: AlgoOptions & { width: number } = { width: 5, room: 1.5, waitForFlip: true };

/** The safety stop for a new position: the trend line for the trend switch, else 2.5 typical moves away. */
export function algoStop(algo: BlitzAlgo, c: AlgoChart, i: number, side: 1 | -1, px: number, opt: AlgoOptions = {}): number {
  if (algo === 'supertrend' && Number.isFinite(c.stLine[i])) {
    const roomStop = px - side * (opt.room ?? 0) * c.atr[i];
    return side === 1 ? Math.min(c.stLine[i], roomStop) : Math.max(c.stLine[i], roomStop);
  }
  return px - side * 2.5 * c.atr[i];
}

/**
 * Moves the stop with the chart, never backwards: along the trend line (keeping `room` from the
 * latest close), or 2.5 typical moves behind the best price.
 */
export function algoTrail(algo: BlitzAlgo, c: AlgoChart, i: number, side: 1 | -1, stop: number, best: number, opt: AlgoOptions = {}, close = best): number {
  let next: number;
  if (algo === 'supertrend' && Number.isFinite(c.stLine[i])) {
    const roomStop = close - side * (opt.room ?? 0) * c.atr[i];
    next = side === 1 ? Math.min(c.stLine[i], roomStop) : Math.max(c.stLine[i], roomStop);
  } else next = best - side * 2.5 * c.atr[i];
  return side === 1 ? Math.max(stop, next) : Math.min(stop, next);
}

export const unusedEma = ema;
