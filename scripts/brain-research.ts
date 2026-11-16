/**
 * Does the neural network (src/trader/brain.ts) make the trader better? For each candle size,
 * every momentum signal is followed minute by minute to its stop or target. Walking forward in
 * time, the network learns each result only once it is finished, and may skip new signals:
 *   - all:           every signal taken (no network);
 *   - network:       skips whatever it expects to lose;
 *   - network+trust: skips only once its skipped signals have clearly lost (what the app does);
 *   - placebo:       the same network trained on shuffled results (3 seeds, averaged). If it does
 *                    as well, the network learned nothing real.
 * One trade at a time, each sized to lose 0.5% of the account at its stop, fees included.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/brain-research.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { TRADER_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, tfSeconds, type BacktestTimeframe } from '../src/engine/backtest';
import { exitLevels, roundTripCostPct } from '../src/engine/rules';
import { brainInputs, createBrain, indicators, learnResult, trusted, wouldSkip } from '../src/trader/brain';

const [outPath = 'brain-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
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
const RISK = 0.005;

interface Row { time: number; x: number[]; r: number; exitTime: number }

function rowsFor(tf: BacktestTimeframe, minStopPct: number): Row[] {
  const sec = tfSeconds(tf);
  const bars = sec === 60 ? base : aggregate(base, sec);
  const sig = computeSignals('macd', bars, 0);
  const ind = indicators(bars);
  const st = { ...TRADER_SETTINGS, minStopPct };
  const cost = roundTripCostPct(st) / 100;
  const rows: Row[] = [];
  let run = 0;
  for (let i = 200; i < bars.length; i++) {
    const score = sig.score[i];
    if (!sig.ready[i] || Math.abs(score) < st.minConfidence) {
      run = 0;
      continue;
    }
    // On 1-minute candles neighbouring signals are near copies: keep every 5th.
    if (sec === 60 && run++ % 5 !== 0) continue;
    const x = brainInputs(bars, ind, i, score, sec);
    if (!x) continue;
    const { stopPct, targetPct } = exitLevels(st, sig.atrPct[i]);
    const dir = score > 0 ? 1 : -1;
    const px = bars[i].close;
    const stop = px * (1 - (dir * stopPct) / 100);
    const target = px * (1 + (dir * targetPct) / 100);
    const time = bars[i].time + sec;
    for (let j = lowerBound(base, time); j < base.length; j++) {
      const m = base[j];
      const hitStop = dir > 0 ? m.low <= stop : m.high >= stop;
      const hitTarget = dir > 0 ? m.high >= target : m.low <= target;
      if (!hitStop && !hitTarget) continue;
      const exit = hitStop ? (dir > 0 ? Math.min(m.open, stop) : Math.max(m.open, stop)) : dir > 0 ? Math.max(m.open, target) : Math.min(m.open, target);
      rows.push({ time, x, r: (dir * (exit / px - 1) - cost) / (stopPct / 100 + cost), exitTime: m.time + 60 });
      break;
    }
  }
  return rows;
}

type Mode = 'all' | 'network' | 'network+trust' | 'placebo' | 'placebo+trust';

function simulate(rows: Row[], mode: Mode, seed = 7) {
  const brain = createBrain(seed);
  let s = seed * 7919;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const done = rows.map((row, k) => ({ row, k })).sort((a, b) => a.row.exitTime - b.row.exitTime);
  const skipAtTime = new Array<boolean>(rows.length).fill(false);
  let d = 0;
  let busyUntil = 0;
  const taken: { time: number; r: number }[] = [];
  let skipped = 0;
  let trustedSince = 0;
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    while (d < done.length && done[d].row.exitTime <= row.time) {
      const { row: f, k: fk } = done[d++];
      const r = mode.startsWith('placebo') ? (rand() < 0.4 ? Math.abs(f.r) : -Math.abs(f.r)) : f.r;
      learnResult(brain, f.x, r, skipAtTime[fk], f.r);
    }
    skipAtTime[k] = wouldSkip(brain, row.x);
    if (row.time < busyUntil) continue;
    if (mode !== 'all') {
      const gate = mode.endsWith('trust') ? trusted(brain) : true;
      if (gate && !trustedSince && row.time >= P.older[0]) trustedSince = row.time;
      if (gate && skipAtTime[k]) {
        skipped++;
        continue;
      }
    }
    taken.push({ time: row.time, r: row.r });
    busyUntil = row.exitTime;
  }
  const out: Record<string, { ret: number; trades: number; won: number }> = {};
  for (const [name, [a, z]] of Object.entries(P)) {
    const t = taken.filter((x) => x.time >= a && x.time < z);
    const eq = t.reduce((e, x) => e * (1 + RISK * x.r), 1);
    out[name] = { ret: +((eq - 1) * 100).toFixed(1), trades: t.length, won: t.filter((x) => x.r > 0).length };
  }
  return { periods: out, skipped, learned: brain.learned, trust: { n: brain.skippedN, avg: brain.skippedN ? +(brain.skippedR / brain.skippedN).toFixed(2) : null, trusted: trusted(brain) } };
}

const result: Record<string, unknown> = {};
for (const [tf, floor] of [['4h', 0], ['1h', 3], ['15m', 3], ['1m', 3]] as [BacktestTimeframe, number][]) {
  const t0 = Date.now();
  const rows = rowsFor(tf, floor);
  const won = rows.filter((r) => r.r > 0).length;
  console.log(`\n${tf} (stop at least ${floor}%): ${rows.length} signals followed, ${Math.round((100 * won) / rows.length)}% reached the target (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const line: Record<string, unknown> = {};
  for (const mode of ['all', 'network', 'network+trust'] as Mode[]) {
    const s = simulate(rows, mode);
    line[mode] = s;
    console.log(`  ${mode.padEnd(14)} ${Object.entries(s.periods).map(([k, v]) => `${k} ${v.ret >= 0 ? '+' : ''}${v.ret}% (${v.trades} tr, ${v.won} won)`).join(' | ')}  skipped ${s.skipped}; trust record ${s.trust.n} skipped, avg ${s.trust.avg}R${s.trust.trusted ? ' (trusted)' : ''}`);
  }
  for (const mode of ['placebo', 'placebo+trust'] as Mode[]) {
    const runs = [11, 23, 37].map((seed) => simulate(rows, mode, seed));
    const avg: Record<string, number> = {};
    for (const k of Object.keys(P)) avg[k] = +(runs.reduce((a, r) => a + r.periods[k].ret, 0) / runs.length).toFixed(1);
    line[mode] = { average: avg, runs };
    console.log(`  ${mode.padEnd(14)} ${Object.entries(avg).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}%`).join(' | ')}  (average of 3 shuffles; trusted in ${runs.filter((r) => r.trust.trusted).length} of 3)`);
  }
  result[tf] = line;
  writeFileSync(outPath, JSON.stringify(result, null, 2));
}
