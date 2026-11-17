/**
 * Blitz without points: chart patterns (src/trader/blitzPatterns.ts) with stops placed where the
 * chart proves the idea wrong and moved with the chart. $150 with $30 a trade, one 2-hour session
 * a day at four times of day (02:00, 08:00, 13:00, 20:00 UTC), session stop at −$3, fees 0.1% each
 * way and 0.02% slippage. Each pattern alone and all together, with two ways of moving the stop,
 * and a placebo that enters at random with the same stops: if a pattern doesn't beat it, the
 * pattern isn't reading anything. Chosen on the older period, checked on the newer one and the
 * hidden days.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/blitz-patterns-research.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { aggregate, computeSignals, lowerBound } from '../src/engine/backtest';
import { findBlitzIdea, readBlitzChart, trailBlitzStop, type BlitzExit, type BlitzPattern } from '../src/trader/blitzPatterns';

const [outPath = 'blitz-patterns-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
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
const AMOUNT = 30;
const FEE = 0.001;
const SLIP = 0.0002;
const SESSION_STOP = 3;
const t0 = Date.now();
const chart = readBlitzChart(base);
process.stderr.write(`chart read in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
// The bigger trend: 4-hour momentum as of each minute (from the last closed 4-hour candle).
const b4 = aggregate(base, 14_400);
const s4 = computeSignals('macd', b4, Math.max(0, lowerBound(b4, P.older[0]) - 400));
const bigTrend = new Int8Array(base.length);
for (let i = 0, j = 0; i < base.length; i++) {
  while (j + 1 < b4.length && b4[j + 1].time + 14_400 <= base[i].time + 60) j++;
  const closed = b4[j].time + 14_400 <= base[i].time + 60 ? j : j - 1;
  const sc = closed >= 0 && s4.ready[closed] ? s4.score[closed] : 0;
  bigTrend[i] = sc >= 50 ? 1 : sc <= -50 ? -1 : 0;
}

interface Result { pnl: number; gross: number; fees: number; trades: number; wins: number }

function session(s0: number, patterns: readonly BlitzPattern[] | 'random', exit: BlitzExit, rand: () => number, aligned = false): Result {
  const end = s0 + 120;
  const r: Result = { pnl: 0, gross: 0, fees: 0, trades: 0, wins: 0 };
  let pos: { side: 'long' | 'short'; entry: number; entryAt: number; stop: number; risk: number; best: number; qty: number } | null = null;
  const close = (price: number) => {
    const p = pos!;
    const fill = p.side === 'long' ? price * (1 - SLIP) : price * (1 + SLIP);
    const gross = p.side === 'long' ? p.qty * (fill - p.entry) : p.qty * (p.entry - fill);
    const fees = FEE * p.qty * (p.entry + fill);
    r.gross += gross;
    r.fees += fees;
    r.pnl += gross - fees;
    r.trades++;
    if (gross - fees > 0) r.wins++;
    pos = null;
  };
  let stopped = false;
  for (let i = s0; i < end && i < base.length; i++) {
    const b = base[i];
    if (pos) {
      const hit = pos.side === 'long' ? b.low <= pos.stop : b.high >= pos.stop;
      if (hit) close(pos.side === 'long' ? Math.min(b.open, pos.stop) : Math.max(b.open, pos.stop));
      else {
        pos.best = pos.side === 'long' ? Math.max(pos.best, b.high) : Math.min(pos.best, b.low);
        pos.stop = trailBlitzStop(base, chart, i, pos, exit);
        if (i === end - 1) close(b.close);
      }
      continue;
    }
    if (stopped || i === s0 || i >= end - 1) continue;
    if (r.pnl <= -SESSION_STOP) {
      stopped = true;
      continue;
    }
    let idea: { side: 'long' | 'short'; stop: number } | null = null;
    if (patterns === 'random') {
      if (rand() < 0.04 && chart.atr[i] > 0) {
        const side = rand() < 0.5 ? 'long' : 'short';
        idea = { side, stop: side === 'long' ? b.close - 1.5 * chart.atr[i] : b.close + 1.5 * chart.atr[i] };
      }
    } else idea = findBlitzIdea(base, chart, i, s0, patterns);
    if (!idea) continue;
    // Only with the bigger 4-hour trend, when asked.
    if (aligned && bigTrend[i] !== (idea.side === 'long' ? 1 : -1)) continue;
    const entry = idea.side === 'long' ? b.close * (1 + SLIP) : b.close * (1 - SLIP);
    pos = { side: idea.side, entry, entryAt: i, stop: idea.stop, risk: Math.abs(b.close - idea.stop), best: b.close, qty: AMOUNT / entry };
  }
  if (pos) close(base[Math.min(end, base.length) - 1].close);
  return r;
}

const ALL: BlitzPattern[] = ['trend-pullback', 'squeeze-breakout', 'sweep-reversal', 'spike-follow', 'range-breakout', 'vwap-reclaim'];
const ALIGNED = process.env.ALIGNED === '1';
const configs: [string, readonly BlitzPattern[] | 'random'][] = ALIGNED
  ? [
      ['all six', ALL],
      ['range-breakout', ['range-breakout']],
      ['trend-pullback', ['trend-pullback']],
      ['sweep-reversal', ['sweep-reversal']],
      ['vwap-reclaim', ['vwap-reclaim']],
      ['placebo: random entries', 'random'],
    ]
  : [
      ...(['trend-pullback', 'squeeze-breakout', 'sweep-reversal', 'spike-follow', 'spike-fade', 'range-breakout', 'vwap-reclaim'] as BlitzPattern[]).map((p): [string, BlitzPattern[]] => [p, [p]]),
      ['all six (not the fade)', ALL],
      ['placebo: random entries', 'random'],
    ];

const out: Record<string, unknown> = {};
for (const exit of ['structure', 'chandelier'] as BlitzExit[]) {
  for (const [name, patterns] of configs) {
    const line: Record<string, unknown> = {};
    const parts: string[] = [];
    for (const [k, [a, z]] of Object.entries(P)) {
      let seed = 99;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const res: Result[] = [];
      for (const h of [2, 8, 13, 20]) {
        for (let d = Math.floor(a / 86400) * 86400; d + 86400 <= z; d += 86400) {
          const s0 = d + h * 3600;
          if (s0 < a) continue;
          const idx = lowerBound(base, s0);
          if (idx >= base.length || base[idx].time !== s0) continue;
          res.push(session(idx, patterns, exit, rand, ALIGNED));
        }
      }
      const n = res.length;
      const sum = (f: (x: Result) => number) => res.reduce((acc, x) => acc + f(x), 0);
      const pnls = res.map((x) => x.pnl).sort((x, y) => x - y);
      const trades = sum((x) => x.trades);
      const L = {
        sessions: n,
        avg: +(sum((x) => x.pnl) / n).toFixed(3),
        beforeFees: +(sum((x) => x.gross) / n).toFixed(3),
        up: Math.round((100 * pnls.filter((x) => x > 0).length) / n),
        best: +pnls[n - 1].toFixed(2),
        worst: +pnls[0].toFixed(2),
        trades: +(trades / n).toFixed(2),
        winRate: trades ? Math.round((100 * sum((x) => x.wins)) / trades) : 0,
      };
      line[k] = L;
      parts.push(`${k}: ${L.avg >= 0 ? '+' : ''}$${L.avg.toFixed(3)} (before fees ${L.beforeFees >= 0 ? '+' : ''}$${L.beforeFees.toFixed(3)}), up ${L.up}%, best $${L.best}, worst $${L.worst}, ${L.trades} trades, ${L.winRate}% won`);
    }
    out[`${name} · ${exit}${ALIGNED ? ' · with the 4-hour trend' : ''}`] = line;
    console.log(`${name} · ${exit} stop${ALIGNED ? ' · with the 4-hour trend' : ''}\n   ${parts.join('\n   ')}`);
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  }
}
