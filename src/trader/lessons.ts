/**
 * Learning from mistakes, in a form you can read. Every signal the bot sees, taken or not, is
 * followed to its stop or target, and its result is filed under one of 8 situations: buying or
 * selling short, with or against the bigger trend, in a calm or a wild market. A situation that has
 * clearly lost money so far is skipped from then on; if it recovers, it is traded again.
 */
import type { BotSettings, Candle, Trade } from '../types';
import { computeSignals, type SignalSeries } from '../engine/backtest';
import { exitLevels, roundTripCostPct } from '../engine/rules';
import { ema } from '../lib/indicators';

export type Situation = `${'long' | 'short'}|${'with' | 'against'}|${'calm' | 'wild'}`;

export interface SituationRecord {
  n: number;
  wins: number;
  sumR: number;
}

export type Lessons = Partial<Record<Situation, SituationRecord>>;

/** Results needed in a situation before the bot acts on its lesson. */
export const LESSON_MIN = 8;
/** Skip a situation once its average result, pulled toward zero for small samples, is below this (in units of risk). */
export const LESSON_SKIP_BELOW = -0.25;
/** How strongly a small sample is pulled toward zero (like this many results at 0). */
const PRIOR = 6;

export const createLessons = (): Lessons => ({});

export const situationOf = (side: 'long' | 'short', withTrend: boolean, wild: boolean): Situation =>
  `${side}|${withTrend ? 'with' : 'against'}|${wild ? 'wild' : 'calm'}`;

export function recordLesson(l: Lessons, s: Situation, r: number): Lessons {
  const rec = (l[s] ??= { n: 0, wins: 0, sumR: 0 });
  rec.n++;
  rec.wins += r > 0 ? 1 : 0;
  rec.sumR += r;
  return l;
}

/** The average result, pulled toward zero when there are few results. */
export const shrunkAverage = (rec: SituationRecord) => rec.sumR / (rec.n + PRIOR);

export function lessonVerdict(l: Lessons, s: Situation): { skip: boolean; rec?: SituationRecord } {
  const rec = l[s];
  if (!rec || rec.n < LESSON_MIN) return { skip: false, rec };
  return { skip: shrunkAverage(rec) < LESSON_SKIP_BELOW, rec };
}

export function describeSituation(s: Situation): string {
  const [side, trend, vol] = s.split('|');
  return `${side === 'long' ? 'Buying' : 'Selling short'} ${trend === 'with' ? 'with' : 'against'} the bigger trend in a ${vol} market`;
}

/* ------------------------------------------------------- learning from the chart's history */

export interface SignalOutcome {
  /** The candle the signal came on, and its score. */
  i: number;
  score: number;
  /** The first candle of a run of signals in the same direction (later ones are near copies). */
  first: boolean;
  /** Unix seconds when the candle closed and the signal was seen. */
  time: number;
  side: 'long' | 'short';
  situation: Situation;
  result: 'target' | 'stop';
  /** Result in units of the money at risk, after fees: about −1 at the stop, about +2.3 at the target. */
  r: number;
  /** Unix seconds when the candle that reached the stop or target closed. */
  exitTime: number;
}

export interface ChartReading {
  sig: SignalSeries;
  e50: number[];
}

/** Reads the closed 4-hour candles once: the momentum signal and the 50-candle average at each. */
export function readChart(bars: Candle[], st: BotSettings): ChartReading {
  return { sig: computeSignals(st.strategy, bars, 0), e50: ema(bars.map((b) => b.close), 50) };
}

/** The situation at candle i for a trade on `side`: with or against the 50-candle trend, calm or wild. */
export function situationAt(bars: Candle[], r: ChartReading, i: number, side: 'long' | 'short'): Situation {
  const dir = side === 'long' ? 1 : -1;
  const atr = r.sig.atrPct[i];
  let sum = 0;
  let n = 0;
  for (let k = Math.max(0, i - 29); k <= i; k++) {
    if (Number.isFinite(r.sig.atrPct[k])) {
      sum += r.sig.atrPct[k];
      n++;
    }
  }
  return situationOf(side, dir * (bars[i].close - r.e50[i]) > 0, n > 0 && atr > sum / n);
}

/**
 * Follows every signal in the history (taken or not) to its stop or target on the next candles,
 * and files each result under its situation. If a candle reaches both, the stop counts.
 *
 * Only signals up to the first one still open are kept. Losers hit their nearer stop sooner than
 * winners reach their target, so the newest finished signals are mostly losers; keeping them would
 * teach the bot that everything loses.
 */
export function learnFromHistory(bars: Candle[], st: BotSettings, reading = readChart(bars, st)): { lessons: Lessons; outcomes: SignalOutcome[] } {
  const barSec = bars.length > 1 ? bars[1].time - bars[0].time : 14_400;
  const cost = roundTripCostPct(st) / 100;
  const outcomes: SignalOutcome[] = [];
  let firstOpen = Infinity;
  for (let i = 60; i < bars.length - 1 && bars[i].time < firstOpen; i++) {
    const score = reading.sig.score[i];
    if (!reading.sig.ready[i] || Math.abs(score) < st.minConfidence) continue;
    const side = score > 0 ? 'long' : 'short';
    const before = reading.sig.score[i - 1];
    const first = !(reading.sig.ready[i - 1] && Math.abs(before) >= st.minConfidence && before > 0 === score > 0);
    const atrPct = reading.sig.atrPct[i];
    if (!(atrPct > 0)) continue;
    const { stopPct, targetPct } = exitLevels(st, atrPct);
    const dir = side === 'long' ? 1 : -1;
    const px = bars[i].close;
    const stop = px * (1 - (dir * stopPct) / 100);
    const target = targetPct > 0 ? px * (1 + (dir * targetPct) / 100) : NaN;
    let open = true;
    for (let j = i + 1; j < bars.length; j++) {
      const b = bars[j];
      const hitStop = side === 'long' ? b.low <= stop : b.high >= stop;
      const hitTarget = side === 'long' ? b.high >= target : b.low <= target;
      if (!hitStop && !hitTarget) continue;
      const exit = hitStop ? (side === 'long' ? Math.min(b.open, stop) : Math.max(b.open, stop)) : side === 'long' ? Math.max(b.open, target) : Math.min(b.open, target);
      const r = (dir * (exit / px - 1) - cost) / (stopPct / 100 + cost);
      const situation = situationAt(bars, reading, i, side);
      open = false;
      outcomes.push({ i, score, first, time: bars[i].time + barSec, side, situation, result: hitStop ? 'stop' : 'target', r, exitTime: b.time + barSec });
      break;
    }
    if (open) firstOpen = bars[i].time;
  }
  const kept = outcomes.filter((o) => o.time - barSec < firstOpen);
  const lessons = createLessons();
  for (const o of kept) recordLesson(lessons, o.situation, o.r);
  return { lessons, outcomes: kept };
}

/** Why a finished trade lost, in plain words, from its situation and how it ended. */
export function lossCause(t: Trade, lessons: Lessons): string {
  const parts: string[] = [];
  const held = t.exitTime - t.entryTime;
  const hours = held / 3_600_000;
  const how = /stop/i.test(t.exitReason)
    ? `The price turned against it and hit the stop after ${hours < 1 ? `${Math.max(1, Math.round(held / 60_000))} minutes` : hours < 48 ? `${hours.toFixed(0)} hours` : `${(hours / 24).toFixed(0)} days`}`
    : t.exitReason;
  parts.push(`${how}.`);
  if (t.situation) {
    const rec = lessons[t.situation as Situation];
    const where = describeSituation(t.situation as Situation).toLowerCase();
    parts.push(
      rec && rec.n
        ? `It was ${where}: in the chart's history such trades won ${Math.round((100 * rec.wins) / rec.n)}% of ${rec.n} times, averaging ${(rec.sumR / rec.n).toFixed(2)}× the risk.`
        : `It was ${where}.`,
    );
  }
  return parts.join(' ');
}
