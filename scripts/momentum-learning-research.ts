/**
 * Can learning from mistakes improve the 4-hour momentum trader? Every 4-hour signal (taken or
 * not) is followed to its stop or target on 1-minute prices. A learner sorts signals into 8
 * situations (buy or short, with or against the bigger trend, calm or wild market) and, walk-
 * forward, skips situations whose results so far are clearly negative. Compared with taking every
 * signal and with a placebo learner that learns from shuffled results. Risk is 1% of the account
 * per trade, fees included.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/momentum-learning-research.ts
 */
import { readFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { aggregate, computeSignals, lowerBound, tfSeconds } from '../src/engine/backtest';
import { ema } from '../src/lib/indicators';
import { createLessons, lessonVerdict, recordLesson, situationOf, type Situation } from '../src/trader/lessons';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const P: Record<string, [number, number]> = {
  older: [utc('2025-03-01T00:00:00'), utc('2026-04-01T00:00:00')],
  newer: [utc('2026-04-01T00:00:00'), utc('2026-10-27T00:00:00')],
};
if (process.env.HIDDEN_FROM) P.hidden = [Number(process.env.HIDDEN_FROM), base[base.length - 1].time + 60];
const COST = 0.0024;
const RISK = 0.01;
const BAR = tfSeconds('4h');
const bars = aggregate(base, BAR);
const sig = computeSignals('macd', bars, Math.max(0, lowerBound(bars, utc('2025-01-20T00:00:00')) - 1));
const e50 = ema(bars.map((b) => b.close), 50);

interface Sig { time: number; side: 'long' | 'short'; entry: number; stop: number; target: number; situation: Situation; r: number; exitTime: number }
const signals: Sig[] = [];
for (let i = 60; i < bars.length; i++) {
  const score = sig.score[i];
  if (!sig.ready[i] || Math.abs(score) < 50) continue;
  const side = score > 0 ? 'long' : 'short';
  const dir = side === 'long' ? 1 : -1;
  const px = bars[i].close;
  const atrPct = sig.atrPct[i] / 100;
  if (!(atrPct > 0)) continue;
  let atrAvg = 0;
  for (let k = i - 29; k <= i; k++) atrAvg += (sig.atrPct[k] || sig.atrPct[i]) / 100 / 30;
  const stopFrac = 2.5 * atrPct;
  const stop = px * (1 - dir * stopFrac);
  const target = px * (1 + dir * 6 * atrPct);
  const time = bars[i].time + BAR;
  const situation = situationOf(side, dir * (px - e50[i]) > 0, atrPct > atrAvg);
  // Follow it minute by minute to the stop or the target.
  let j = lowerBound(base, time);
  let exit = 0;
  let exitTime = 0;
  for (; j < base.length; j++) {
    const m = base[j];
    if (side === 'long' ? m.low <= stop : m.high >= stop) { exit = side === 'long' ? Math.min(m.open, stop) : Math.max(m.open, stop); exitTime = m.time + 60; break; }
    if (side === 'long' ? m.high >= target : m.low <= target) { exit = side === 'long' ? Math.max(m.open, target) : Math.min(m.open, target); exitTime = m.time + 60; break; }
  }
  if (!exitTime) continue;
  const move = dir * (exit / px - 1);
  // Result in units of the money at risk (stop distance plus fees).
  signals.push({ time, side, entry: px, stop, target, situation, r: (move - COST) / (stopFrac + COST), exitTime });
}

function simulate([a, z]: [number, number], mode: 'all' | 'learn' | 'placebo' | 'trusted') {
  let equity = 10_000;
  let peak = equity;
  let dd = 0;
  let busyUntil = 0;
  let trades = 0;
  let wins = 0;
  let skipped = 0;
  const lessons = createLessons();
  const done = [...signals].sort((x, y) => x.exitTime - y.exitTime);
  let k = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  // The trust check: results of the signals the learner skipped, once they are known.
  const skippedOpen: Sig[] = [];
  let skippedN = 0;
  let skippedR = 0;
  for (const s of signals) {
    for (let q = skippedOpen.length - 1; q >= 0; q--) if (skippedOpen[q].exitTime <= s.time) { skippedN++; skippedR += skippedOpen[q].r; skippedOpen.splice(q, 1); }
    while (k < done.length && done[k].exitTime <= s.time) {
      const d = done[k++];
      recordLesson(lessons, d.situation, mode === 'placebo' ? (rand() < 0.4 ? Math.abs(d.r) : -Math.abs(d.r)) : d.r);
    }
    if (s.time < a || s.time >= z || s.time < busyUntil) continue;
    if (mode !== 'all' && lessonVerdict(lessons, s.situation).skip) {
      const trusted = mode !== 'trusted' || skippedN < 5 || skippedR < 0;
      skippedOpen.push(s);
      if (trusted) {
        skipped++;
        continue;
      }
    }
    const pnl = equity * RISK * s.r;
    equity += pnl;
    trades++;
    wins += pnl > 0 ? 1 : 0;
    busyUntil = s.exitTime;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, (peak - equity) / peak);
  }
  return `${((equity / 10_000 - 1) * 100).toFixed(1)}% (${trades} trades, ${wins} won, ${skipped} skipped, drop ${(dd * 100).toFixed(1)}%)`;
}

console.log(`${signals.length} signals followed.`);
for (const mode of ['all', 'learn', 'placebo', 'trusted'] as const) {
  console.log(`${mode.padEnd(8)} ${Object.entries(P).map(([k, p]) => `${k}: ${simulate(p, mode)}`).join(' | ')}`);
}
