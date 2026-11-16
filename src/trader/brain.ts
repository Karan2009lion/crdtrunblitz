import type { Candle } from '../types';
import type { SignalOutcome } from './lessons';
import { atr, bollinger, ema, rsi } from '../lib/indicators';
import { createNet, observe, predict, train, type NetState } from '../ai/net';

/**
 * The bot's neural network. For every signal the chart gives (taken or not) it sees 14
 * measurements of the chart, and once the signal reaches its stop or target it learns from the
 * result. It then estimates each new signal's chance of reaching the target.
 *
 * It earns the right to skip trades: it only filters once the signals it would have skipped
 * have clearly lost money (its "trust record"). Until then it watches and learns.
 */

export const BRAIN_INPUTS = [
  'Direction (buy +1, short −1)',
  'Signal strength',
  'Short trend (20 vs 50 average)',
  'Main trend (50 vs 200 average)',
  'Price vs 200 average',
  'Move over the last 3 candles',
  'Move over the last 12 candles',
  'Move over the last 48 candles',
  'RSI',
  'Place in the Bollinger band',
  'Volume vs usual',
  'Volatility vs usual',
  'Hour of day (sine)',
  'Hour of day (cosine)',
] as const;

export interface Indicators {
  e20: number[];
  e50: number[];
  e200: number[];
  rsi: number[];
  bbUpper: number[];
  bbLower: number[];
  atr: number[];
}

export function indicators(bars: Candle[]): Indicators {
  const close = bars.map((b) => b.close);
  const bb = bollinger(close, 20, 2);
  return { e20: ema(close, 20), e50: ema(close, 50), e200: ema(close, 200), rsi: rsi(close, 14), bbUpper: bb.upper, bbLower: bb.lower, atr: atr(bars, 14) };
}

const clip = (v: number, lim = 5) => (Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);

/** The 14 inputs at candle i for a signal of the given score (+ buy, − short). Null while warming up. */
export function brainInputs(bars: Candle[], ind: Indicators, i: number, score: number, barSec: number): number[] | null {
  if (i < 200) return null;
  const px = bars[i].close;
  const atrPct = ind.atr[i] / px;
  if (!(atrPct > 0)) return null;
  const dir = score >= 0 ? 1 : -1;
  let vol = 0;
  let volatility = 0;
  for (let k = i - 47; k <= i; k++) {
    vol += bars[k].volume / 48;
    volatility += (Number.isFinite(ind.atr[k]) ? ind.atr[k] / bars[k].close : atrPct) / 48;
  }
  const move = (k: number) => clip((Math.log(px / bars[i - k].close) / (atrPct * Math.sqrt(k))) * dir);
  const hour = (((bars[i].time + barSec) % 86_400) / 86_400) * 2 * Math.PI;
  const band = ind.bbUpper[i] - ind.bbLower[i];
  return [
    dir,
    Math.abs(score) / 100,
    clip(((ind.e20[i] / ind.e50[i] - 1) / atrPct) * dir),
    clip(((ind.e50[i] / ind.e200[i] - 1) / atrPct) * dir),
    clip(((px / ind.e200[i] - 1) / atrPct) * dir),
    move(3),
    move(12),
    move(48),
    ((ind.rsi[i] - 50) / 50) * dir,
    clip((band > 0 ? ((px - ind.bbLower[i]) / band) * 2 - 1 : 0) * dir, 3),
    clip(Math.log((bars[i].volume + 1e-9) / (vol + 1e-9)), 3),
    clip(Math.log(atrPct / (volatility || atrPct)), 3),
    Math.sin(hour),
    Math.cos(hour),
  ];
}

export interface Brain {
  net: NetState;
  /** Results learned from. */
  learned: number;
  wins: number;
  /** Average result of wins and of losses, in units of risk. */
  avgWin: number;
  avgLoss: number;
  /** The trust record: signals it would have skipped when they appeared, and their total result. */
  skippedN: number;
  skippedR: number;
}

/** Results to learn from before the network's opinion means anything. */
export const BRAIN_WARMUP = 100;
/**
 * Skipped signals needed, and how clearly they must have lost (average, in units of risk), before it
 * filters. Only the first candle of each run of signals counts, so 30 means 30 separate occasions.
 */
export const TRUST_MIN = 30;
export const TRUST_AVG = -0.15;

export function createBrain(seed = 7): Brain {
  return { net: createNet(BRAIN_INPUTS.length, 12, seed), learned: 0, wins: 0, avgWin: 2.3, avgLoss: 1, skippedN: 0, skippedR: 0 };
}

/** Chance of reaching the target, and the expected result in units of risk. */
export function brainView(b: Brain, x: number[]): { p: number; expected: number } {
  const p = predict(b.net, x);
  return { p, expected: p * b.avgWin - (1 - p) * b.avgLoss };
}

/** Whether the network, knowing what it knows now, would skip this signal. */
export const wouldSkip = (b: Brain, x: number[]) => b.learned >= BRAIN_WARMUP && brainView(b, x).expected < 0;

/** True once the signals it would have skipped have clearly lost money. */
export const trusted = (b: Brain) => b.skippedN >= TRUST_MIN && b.skippedR / b.skippedN <= TRUST_AVG;

/**
 * Learns from one finished signal. `skippedAtTheTime` is what the network said when the signal
 * appeared, which feeds its trust record with the signal's real result `actual` (the research's
 * placebo trains on a shuffled `r` but is still judged on what really happened).
 */
export function learnResult(b: Brain, x: number[], r: number, skippedAtTheTime: boolean, actual = r): void {
  observe(b.net, x);
  train(b.net, x, r > 0 ? 1 : 0);
  b.learned++;
  if (r > 0) {
    b.wins++;
    b.avgWin += (r - b.avgWin) / Math.min(b.wins, 200);
  } else {
    const losses = b.learned - b.wins;
    b.avgLoss += (-r - b.avgLoss) / Math.min(losses, 200);
  }
  if (skippedAtTheTime) {
    b.skippedN++;
    b.skippedR += actual;
  }
}

/**
 * Builds the network from a history of finished signals, walking forward in time: each signal is
 * judged with only the results that had finished before it, which also builds the trust record.
 */
export function trainBrain(bars: Candle[], outcomes: SignalOutcome[], barSec: number): Brain {
  const brain = createBrain();
  const ind = indicators(bars);
  const rows = outcomes
    .map((o) => ({ time: o.time, exitTime: o.exitTime, r: o.r, first: o.first, x: brainInputs(bars, ind, o.i, o.score, barSec) }))
    .filter((r): r is { time: number; exitTime: number; r: number; first: boolean; x: number[] } => r.x !== null);
  const done = rows.map((row, k) => ({ row, k })).sort((a, b) => a.row.exitTime - b.row.exitTime);
  const skipAtTime = new Array<boolean>(rows.length).fill(false);
  let d = 0;
  for (let k = 0; k < rows.length; k++) {
    while (d < done.length && done[d].row.exitTime <= rows[k].time) {
      const f = done[d++];
      learnResult(brain, f.row.x, f.row.r, skipAtTime[f.k] && f.row.first);
    }
    skipAtTime[k] = wouldSkip(brain, rows[k].x);
  }
  for (; d < done.length; d++) learnResult(brain, done[d].row.x, done[d].row.r, skipAtTime[done[d].k] && done[d].row.first);
  return brain;
}

/** The network's inputs for a signal on the last of `closedBars` (oldest first). */
export function inputsNow(closedBars: Candle[], score: number, barSec: number): number[] | null {
  const bars = closedBars.slice(-400);
  return brainInputs(bars, indicators(bars), bars.length - 1, score, barSec);
}
