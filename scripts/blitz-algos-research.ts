/**
 * New Blitz algorithms that trade often (src/trader/blitzAlgos.ts), tested the same way as before:
 * $150 with $30 a trade, one 2-hour session a day at four times of day, session stop at −$3.
 * Costs as Blitz runs now: waiting (limit) orders to enter (no slippage) and the BNB fee rate,
 * 0.075% each way, 0.02% slippage on exits. A placebo flips at random at the same pace.
 * Chosen on the older period, checked on the newer one and the hidden days.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/blitz-algos-research.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { lowerBound } from '../src/engine/backtest';
import { algoStop, algoTrail, algoWant, readAlgoChart, type AlgoOptions, type BlitzAlgo, type Want } from '../src/trader/blitzAlgos';

const [outPath = 'blitz-algos-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
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
const FEE = 0.00075;
const EXIT_SLIP = 0.0002;
let c = readAlgoChart(base);
const WIDTHS = (process.env.WIDTHS || '').split(',').filter(Boolean).map(Number);

interface R { pnl: number; gross: number; trades: number; wins: number }

function session(s0: number, algo: BlitzAlgo | 'random', rand: () => number, opt: AlgoOptions = {}): R {
  const end = s0 + 120;
  const r: R = { pnl: 0, gross: 0, trades: 0, wins: 0 };
  let pos: { side: 1 | -1; entry: number; qty: number; stop: number; best: number } | null = null;
  const close = (price: number) => {
    const p = pos!;
    const fill = price * (1 - p.side * EXIT_SLIP);
    const gross = p.side * p.qty * (fill - p.entry);
    const fees = FEE * p.qty * (p.entry + fill);
    r.gross += gross;
    r.pnl += gross - fees;
    r.trades++;
    if (gross - fees > 0) r.wins++;
    pos = null;
  };
  let held: Want = 0;
  let blocked: Want = 0;
  for (let i = s0; i < end && i < base.length; i++) {
    const b = base[i];
    if (pos) {
      if (pos.side === 1 ? b.low <= pos.stop : b.high >= pos.stop) {
        if (opt.waitForFlip) blocked = pos.side;
        close(pos.side === 1 ? Math.min(b.open, pos.stop) : Math.max(b.open, pos.stop));
        held = 0;
      } else {
        pos.best = pos.side === 1 ? Math.max(pos.best, b.high) : Math.min(pos.best, b.low);
        pos.stop = algo === 'random' ? pos.stop : algoTrail(algo, c, i, pos.side, pos.stop, pos.best, opt, b.close);
      }
    }
    if (i === end - 1) {
      if (pos) close(b.close);
      break;
    }
    if (r.pnl <= -3) {
      if (pos) close(b.close);
      break;
    }
    let want: Want;
    if (algo === 'random') want = rand() < 0.06 ? (rand() < 0.5 ? 1 : -1) : held;
    else want = algoWant(algo, base, c, i, held);
    // After a stop-out, wait for the trend line to flip before going that way again.
    if (blocked && algo === 'supertrend' && c.stDir[i] !== blocked) blocked = 0;
    if (blocked && want === blocked) want = 0;
    if (want === held && (pos || want === 0)) continue;
    if (pos && want !== pos.side) close(b.close);
    if (want !== 0 && !pos && c.atr[i] > 0) {
      const entry = b.close;
      pos = { side: want, entry, qty: AMOUNT / entry, stop: algo === 'random' ? entry - want * 2.5 * c.atr[i] : algoStop(algo, c, i, want, entry, opt), best: entry };
    }
    held = want;
  }
  return r;
}

const out: Record<string, unknown> = {};
const RUNS: [string, BlitzAlgo | 'random', AlgoOptions][] = process.env.TREND_FIX
  ? [
      ['trend switch, as run on 18 Nov', 'supertrend', {}],
      ['room 1 move', 'supertrend', { room: 1 }],
      ['room 1.5 moves', 'supertrend', { room: 1.5 }],
      ['room 2.5 moves', 'supertrend', { room: 2.5 }],
      ['wait for a flip after a stop', 'supertrend', { waitForFlip: true }],
      ['room 1.5 + wait for a flip', 'supertrend', { room: 1.5, waitForFlip: true }],
      ['room 2.5 + wait for a flip', 'supertrend', { room: 2.5, waitForFlip: true }],
      ['room 4 + wait for a flip', 'supertrend', { room: 4, waitForFlip: true }],
    ]
  : (['supertrend', 'hull-turns', 'regime-switch', 'pressure', 'snap-back', 'random'] as (BlitzAlgo | 'random')[]).map((a): [string, BlitzAlgo | 'random', AlgoOptions] => [a, a, {}]);
const all: [string, BlitzAlgo | 'random', AlgoOptions, number][] = WIDTHS.length
  ? WIDTHS.map((w): [string, BlitzAlgo | 'random', AlgoOptions, number] => [`line ${w} moves away, room 1.5 + wait for a flip`, 'supertrend', { room: 1.5, waitForFlip: true }, w])
  : RUNS.map(([l, a, o]): [string, BlitzAlgo | 'random', AlgoOptions, number] => [l, a, o, 3]);
let width = 3;
for (const [label, algo, opt, w] of all) {
  if (w !== width) {
    c = readAlgoChart(base, w);
    width = w;
  }
  const line: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [k, [a, z]] of Object.entries(P)) {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const res: R[] = [];
    for (const h of [2, 8, 13, 20]) {
      for (let d = Math.floor(a / 86400) * 86400; d + 86400 <= z; d += 86400) {
        const s0 = d + h * 3600;
        if (s0 < a) continue;
        const idx = lowerBound(base, s0);
        if (idx >= base.length || base[idx].time !== s0) continue;
        res.push(session(idx, algo, rand, opt));
      }
    }
    const n = res.length;
    const sum = (f: (x: R) => number) => res.reduce((acc, x) => acc + f(x), 0);
    const pn = res.map((x) => x.pnl).sort((x, y) => x - y);
    const trades = sum((x) => x.trades);
    const L = {
      avg: +(sum((x) => x.pnl) / n).toFixed(3),
      beforeFees: +(sum((x) => x.gross) / n).toFixed(3),
      up: Math.round((100 * pn.filter((x) => x > 0).length) / n),
      best: +pn[n - 1].toFixed(2),
      worst: +pn[0].toFixed(2),
      trades: +(trades / n).toFixed(1),
      winRate: trades ? Math.round((100 * sum((x) => x.wins)) / trades) : 0,
    };
    line[k] = L;
    parts.push(`${k}: ${L.avg >= 0 ? '+' : ''}$${L.avg.toFixed(3)} a session (before fees ${L.beforeFees >= 0 ? '+' : ''}$${L.beforeFees.toFixed(3)}), up ${L.up}%, best $${L.best}, worst $${L.worst}, ${L.trades} trades, ${L.winRate}% won`);
  }
  out[label] = line;
  console.log(`${label}\n   ${parts.join('\n   ')}`);
}
writeFileSync(outPath, JSON.stringify(out, null, 2));
