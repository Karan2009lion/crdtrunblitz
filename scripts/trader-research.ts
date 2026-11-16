/**
 * Tests the trader (src/trader): setups in both directions, stops sized by money, and a learner
 * that learns from every setup's outcome. On 1-minute BTC prices:
 *   - every setup taken (no learning), as a baseline;
 *   - the learner, walk-forward: it only ever knows outcomes finished before each decision;
 *   - a placebo learner trained on shuffled outcomes: if it does as well, the learner is only
 *     memorising noise;
 *   - the learner with groups of inputs hidden, to see what it relies on.
 * Settings are chosen on the older period only (DEV) and checked on the newer one (VAL).
 *
 *   DATA=BTCUSDT.csv npx vite-node scripts/trader-research.ts -- [cache.json] [out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { findCandidates, resolveStep, TRADER, type Candidate, type Outcome, type TraderOptions } from '../src/trader/setups';
import { createBrain, expectedR, learn, winChance, WARM } from '../src/trader/learner';

const [cachePath = 'trader-candidates.json', outPath = 'trader-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
const utc = (s: string) => Date.parse(s + 'Z') / 1000;
export const PERIODS = {
  dev: [utc('2025-03-01T00:00:00'), utc('2026-04-01T00:00:00')],
  val: [utc('2026-04-01T00:00:00'), utc('2026-10-27T00:00:00')],
} as Record<string, [number, number]>;
const COST_PCT = 2 * (0.1 + 0.02); // fees and slippage, both ways
// The setup timeframe and exits can be varied from the command line.
const BAR = Number(process.env.BAR_SEC || TRADER.barSec);
const OPT: TraderOptions = {
  barSec: BAR,
  targetR: Number(process.env.TARGET_R || TRADER.targetR),
  maxHoldMin: (BAR / 60) * 48,
  minStopPct: Number(process.env.MIN_STOP || TRADER.minStopPct),
  maxStopPct: 6,
  lookback: (300 * BAR) / 60,
};
const RISK_PCT = 0.5; // the most one trade may lose, in % of the account, fees included

const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const endTime = base[base.length - 1].time;
if (process.env.HIDDEN_FROM) PERIODS.hidden = [Number(process.env.HIDDEN_FROM), endTime + 60];

type Row = { c: Candidate; o: Outcome };
let rows: Row[];
if (existsSync(cachePath) && !process.env.REBUILD) {
  rows = JSON.parse(readFileSync(cachePath, 'utf8'));
} else {
  rows = [];
  const t0 = Date.now();
  const first = base.findIndex((c) => c.time >= utc('2025-01-12T00:00:00'));
  for (let i = Math.max(first, OPT.lookback); i < base.length; i++) {
    if ((base[i].time + 60) % OPT.barSec !== 0) continue;
    for (const c of findCandidates(base.slice(i - OPT.lookback + 1, i + 1), OPT)) {
      let o: Outcome | null = null;
      for (let j = i + 1; j < base.length && !o; j++) o = resolveStep(c, base[j], COST_PCT, OPT.maxHoldMin);
      if (o) rows.push({ c, o });
    }
  }
  writeFileSync(cachePath, JSON.stringify(rows));
  process.stderr.write(`${rows.length} setups found and followed in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

/** Account change from one trade, sized so the stop (fees included) loses RISK_PCT of the account. */
function tradePnl(equity: number, c: Candidate, o: Outcome): number {
  const stopFrac = Math.abs(c.entry - c.stop) / c.entry;
  const cost = COST_PCT / 100;
  const move = o.r * stopFrac + cost; // the price move in the trade's favour
  const size = Math.min(equity, (equity * RISK_PCT) / 100 / (stopFrac + cost));
  return size * (move - cost);
}

interface Sim {
  trades: { c: Candidate; o: Outcome; pnl: number; equity: number }[];
  curve: { t: number; equity: number }[];
}

/**
 * Walks the setups in time order. `take` decides; the learner (if any) is first taught every
 * outcome that finished before the setup appeared.
 */
function simulate([a, z]: [number, number], take: (c: Candidate) => boolean, teach?: (r: Row) => void): Sim {
  let equity = 10_000;
  let busyUntil = 0;
  const trades: Sim['trades'] = [];
  const curve: Sim['curve'] = [{ t: a, equity }];
  const done = [...rows].sort((x, y) => x.o.time - y.o.time);
  let k = 0;
  for (const r of rows) {
    if (teach) while (k < done.length && done[k].o.time <= r.c.time) teach(done[k++]);
    if (r.c.time < a || r.c.time >= z) continue;
    if (r.c.time < busyUntil || !take(r.c)) continue;
    const pnl = tradePnl(equity, r.c, r.o);
    equity += pnl;
    busyUntil = r.o.time;
    trades.push({ c: r.c, o: r.o, pnl, equity });
    curve.push({ t: r.o.time, equity });
  }
  return { trades, curve };
}

function stats(s: Sim, [a, z]: [number, number]) {
  const eq = s.curve.map((p) => p.equity);
  let peak = eq[0];
  let dd = 0;
  for (const v of eq) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, (peak - v) / peak);
  }
  const wins = s.trades.filter((t) => t.pnl > 0).length;
  // 15-day windows: the account change over each 15 days.
  const win15: number[] = [];
  for (let t = a; t + 15 * 86400 <= z; t += 15 * 86400) {
    const at = (x: number) => [...s.curve].reverse().find((p) => p.t <= x)?.equity ?? 10_000;
    win15.push((at(t + 15 * 86400) / at(t) - 1) * 100);
  }
  const sorted = [...win15].sort((x, y) => x - y);
  return {
    ret: +((eq[eq.length - 1] / 10_000 - 1) * 100).toFixed(1),
    trades: s.trades.length,
    perDay: +(s.trades.length / ((z - a) / 86400)).toFixed(2),
    win: s.trades.length ? Math.round((100 * wins) / s.trades.length) : 0,
    dd: +(dd * 100).toFixed(1),
    worstTrade: +Math.min(0, ...s.trades.map((t) => (t.pnl / (t.equity - t.pnl)) * 100)).toFixed(2),
    fifteenDay: sorted.length ? { median: +sorted[sorted.length >> 1].toFixed(1), worst: +sorted[0].toFixed(1), best: +sorted[sorted.length - 1].toFixed(1), positive: Math.round((100 * sorted.filter((x) => x > 0).length) / sorted.length) } : null,
  };
}

function learnerRun(period: [number, number], edge: number, opts: { shuffle?: boolean; mask?: number[] } = {}) {
  const brain = createBrain();
  let seed = 17;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const masked = (c: Candidate) => (opts.mask ? { ...c, features: c.features.map((v, i) => (opts.mask!.includes(i) ? 0 : v)) } : c);
  const sim = simulate(
    period,
    (c) => brain.learned >= WARM && expectedR(brain, winChance(brain, masked(c).features)) > edge,
    (r) => {
      const o = opts.shuffle ? { ...r.o, r: rand() < 0.4 ? Math.abs(r.o.r) : -Math.abs(r.o.r) } : r.o;
      learn(brain, masked(r.c), o);
    },
  );
  return { sim, brain };
}

const out: Record<string, unknown> = {};
const report = (name: string, f: (p: [number, number]) => Sim) => {
  const line: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(PERIODS)) line[k] = stats(f(p), p);
  out[name] = line;
  console.log(`${name.padEnd(46)} ${Object.entries(line).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n'.padEnd(48))}`);
};

console.log(`${rows.length} setups. Result per setup (no learning):`);
console.log('Options:', JSON.stringify(OPT));
for (const setup of ['pullback', 'breakout', 'reversal', 'momentum'])
  for (const side of ['long', 'short']) {
    const rs = rows.filter((r) => r.c.setup === setup && r.c.side === side && r.c.time >= PERIODS.dev[0] && r.c.time < PERIODS.dev[1]);
    const avg = rs.reduce((s, r) => s + r.o.r, 0) / (rs.length || 1);
    console.log(`  ${setup} ${side}: ${rs.length} in DEV, won ${Math.round((100 * rs.filter((r) => r.o.r > 0).length) / (rs.length || 1))}%, average ${avg.toFixed(3)}R`);
  }
console.log('');
report('Every setup taken (no learning)', (p) => simulate(p, () => true));
for (const edge of [0, 0.1, 0.2, 0.3]) report(`Learner, takes when expected > ${edge}R`, (p) => learnerRun(p, edge).sim);
for (const edge of [0, 0.2]) report(`Placebo: shuffled outcomes, > ${edge}R`, (p) => learnerRun(p, edge, { shuffle: true }).sim);
const groups: Record<string, number[]> = { 'setup and direction': [0, 1, 2, 3, 4], trend: [5, 6, 7], 'recent moves': [8, 9, 10], 'RSI and bands': [11, 12], 'volume and volatility': [13, 14, 15], 'time of day': [16, 17] };
for (const [g, idx] of Object.entries(groups)) report(`Learner > 0.2R, hiding ${g}`, (p) => learnerRun(p, 0.2, { mask: idx }).sim);

// Is it learning? Taken-trade win rate and average R by quarter, in one continuous run.
const full: [number, number] = [PERIODS.dev[0], Object.values(PERIODS).reduce((m, p) => Math.max(m, p[1]), 0)];
const run = learnerRun(full, 0.2).sim;
const byQ = new Map<string, { n: number; w: number; r: number }>();
for (const t of run.trades) {
  const d = new Date(t.c.time * 1000);
  const q = `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  const e = byQ.get(q) ?? { n: 0, w: 0, r: 0 };
  e.n++;
  e.w += t.pnl > 0 ? 1 : 0;
  e.r += t.o.r;
  byQ.set(q, e);
}
out.learningCurve = [...byQ].map(([q, e]) => ({ q, trades: e.n, win: Math.round((100 * e.w) / e.n), avgR: +(e.r / e.n).toFixed(3) }));
console.log('\nLearner (> 0.2R), quarter by quarter:', JSON.stringify(out.learningCurve));
writeFileSync(outPath, JSON.stringify(out, null, 2));
