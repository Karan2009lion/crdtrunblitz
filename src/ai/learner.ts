import type { Candle } from '../types';
import { FEATURE_COUNT, HORIZON_MIN, featureRows, labelAt } from './features';
import { createNet, observe, predict, train, type NetState } from './net';

export interface CallStats {
  calls: number;
  correct: number;
}

export interface LearnerState {
  net: NetState;
  /** Open time (unix seconds) of the newest candle the network has learned from. */
  trainedUntil: number;
  /** Examples learned from in total. */
  samples: number;
  /** First training: trained on the older 80% of the history, then tested on the newest 20% it hadn't seen. */
  historyCheck: CallStats | null;
  /** Calls made in real time, as each minute closed, then checked 15 minutes later. */
  live: CallStats;
  /** Real-time calls still waiting for their outcome. */
  pending: { time: number; pUp: number }[];
  /** 1 for a right call, 0 for a wrong one, newest last (up to 200). */
  recent: number[];
  /** The latest prediction: chance the price is higher HORIZON_MIN minutes after `time`. */
  latest: { time: number; pUp: number } | null;
}

const EPOCHS = 3;
const RECENT = 200;

export function createLearner(): LearnerState {
  return { net: createNet(FEATURE_COUNT), trainedUntil: 0, samples: 0, historyCheck: null, live: { calls: 0, correct: 0 }, pending: [], recent: [], latest: null };
}

const isRight = (pUp: number, y: 0 | 1) => (pUp >= 0.5 ? 1 : 0) === y;

/** Seeded shuffle, so training is repeatable. */
function shuffled(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/**
 * Learns from 1-minute candles whose outcome is already known.
 * A fresh network trains on the older 80% for a few passes and is tested on the newest 20% (after a
 * 15-minute gap, so no outcome overlaps), then learns those too. A network that has learned before
 * takes each new minute once, in order. A minute it made a real-time call on is scored first; only
 * those count, because a call made later could lean on outcomes it has since learned.
 */
export function learnFromHistory(state: LearnerState, candles: Candle[]): LearnerState {
  const rows = featureRows(candles);
  const fresh: { x: Float64Array; y: 0 | 1; time: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const x = rows[i];
    const y = labelAt(candles, i);
    if (x && y !== null && candles[i].time > state.trainedUntil) fresh.push({ x, y, time: candles[i].time });
  }
  if (!fresh.length) return state;
  const net = state.net;
  let { samples, historyCheck, live, recent } = state;

  if (samples === 0 && fresh.length >= 500) {
    const cut = Math.floor(fresh.length * 0.8);
    const older = fresh.slice(0, cut);
    const newer = fresh.slice(cut + HORIZON_MIN);
    for (const s of older) observe(net, s.x);
    for (let e = 0; e < EPOCHS; e++) for (const k of shuffled(older.length, 11 + e)) train(net, older[k].x, older[k].y);
    let correct = 0;
    for (const s of newer) correct += isRight(predict(net, s.x), s.y) ? 1 : 0;
    historyCheck = { calls: newer.length, correct };
    for (const s of newer) observe(net, s.x);
    for (let e = 0; e < EPOCHS; e++) for (const k of shuffled(newer.length, 23 + e)) train(net, newer[k].x, newer[k].y);
    samples = fresh.length;
  } else {
    live = { ...live };
    recent = [...recent];
    const calls = new Map(state.pending.map((p) => [p.time, p.pUp]));
    for (const s of fresh) {
      const pUp = calls.get(s.time);
      if (pUp !== undefined) {
        const right = isRight(pUp, s.y) ? 1 : 0;
        live.calls++;
        live.correct += right;
        recent.push(right);
      }
      observe(net, s.x);
      train(net, s.x, s.y);
      samples++;
    }
    if (recent.length > RECENT) recent = recent.slice(-RECENT);
  }
  const trainedUntil = fresh[fresh.length - 1].time;
  return { ...state, net, samples, historyCheck, live, recent, trainedUntil, pending: state.pending.filter((p) => p.time > trainedUntil) };
}

/**
 * Called when a 1-minute candle closes (`candles` are closed candles, oldest first, at least a few
 * hours of them). Learns every minute whose 15-minute outcome is now known, checking its call
 * first, then predicts the newest one.
 */
export function onCandleClosed(state: LearnerState, candles: Candle[]): LearnerState {
  const next = learnFromHistory(state, candles);
  const rows = featureRows(candles.slice(-300));
  const x = rows[rows.length - 1];
  const last = candles[candles.length - 1];
  if (!x || !last || next.samples === 0) return next;
  const call = { time: last.time, pUp: predict(next.net, x) };
  const pending = [...next.pending.filter((p) => p.time !== call.time), call].slice(-HORIZON_MIN * 4);
  return { ...next, latest: call, pending };
}

export { HORIZON_MIN };
