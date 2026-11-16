/**
 * Picked settings for the app's former Quick mode (since replaced by Live mode, see
 * live-mode-research.ts): decide on 30-minute candles, hold each trade at most
 * 30 minutes, then wait 30 minutes (so at most one trade an hour). Chosen on the development
 * period only (both halves), then checked on validation and test.
 *
 *   DATA=BTCUSDT.csv npx vite-node scripts/quick-mode-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds } from '../src/engine/backtest';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const P = {
  devA: [utc('2025-03-01T00:00:00'), utc('2025-09-15T00:00:00')],
  devB: [utc('2025-09-15T00:00:00'), utc('2026-04-01T00:00:00')],
  val: [utc('2026-04-01T00:00:00'), utc('2026-10-07T00:00:00')],
  test: [utc('2026-10-07T00:00:00'), utc('2026-10-27T02:28:00')],
} as const;
const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const bars = aggregate(base, tfSeconds('30m'));
const rows: { name: string; st: BotSettings; r: Record<string, { ret: number; trades: number; win: number }> }[] = [];
for (const strategy of ['smart', 'ema', 'rsi', 'bollinger', 'macd', 'breakout', 'pullback'] as StrategyId[]) {
  const signals = computeSignals(strategy, bars, Math.max(0, lowerBound(bars, P.devA[0]) - 1));
  for (const minConfidence of [50, 60, 70])
    for (const [stopAtr, targetAtr] of [[1, 1.5], [1.5, 2], [2, 3], [1.5, 0]])
      for (const allowShort of [true, false]) {
        const st: BotSettings = { ...SETTINGS, strategy, minConfidence, stopAtr, targetAtr, allowShort, feeFilter: false, maxHoldMin: 30, cooldownSec: 1800 };
        const r: Record<string, { ret: number; trades: number; win: number }> = {};
        for (const [k, [a, z]] of Object.entries(P)) {
          const s = runBacktest({ base, start: a, end: z, timeframe: '30m', settings: st, startCash: 10_000, bars, signals, quiet: true }).stats;
          r[k] = { ret: +s.returnPct.toFixed(1), trades: s.trades, win: Math.round(s.winRate) };
        }
        rows.push({ name: `${strategy} ≥${minConfidence} stop ${stopAtr} ATR target ${targetAtr || 'none'} ${allowShort ? 'long+short' : 'long only'}`, st, r });
      }
}
const worstDev = (x: (typeof rows)[number]) => Math.min(x.r.devA.ret, x.r.devB.ret);
rows.sort((a, b) => worstDev(b) - worstDev(a));
const fmt = (x: (typeof rows)[number]) => `${x.name.padEnd(52)} devA ${x.r.devA.ret}% (${x.r.devA.trades})  devB ${x.r.devB.ret}% (${x.r.devB.trades})  val ${x.r.val.ret}% (${x.r.val.trades}, win ${x.r.val.win}%)  test ${x.r.test.ret}% (${x.r.test.trades})`;
console.log(`${rows.length} configs; profitable in both dev halves: ${rows.filter((x) => worstDev(x) > 0).length}; also in validation: ${rows.filter((x) => worstDev(x) > 0 && x.r.val.ret > 0).length}`);
console.log('Top 8 by the weaker development half:');
for (const x of rows.slice(0, 8)) console.log('  ' + fmt(x));
const med = (k: string) => [...rows].map((x) => x.r[k].ret).sort((a, b) => a - b)[rows.length >> 1];
console.log(`Median: devA ${med('devA')}%  devB ${med('devB')}%  val ${med('val')}%  test ${med('test')}%`);

// Quick mode should trade a few times a day, so also rank the active configs (1–6 trades a day in development).
const days = (k: keyof typeof P) => (P[k][1] - P[k][0]) / 86400;
const active = rows.filter((x) => ['devA', 'devB'].every((k) => x.r[k].trades / days(k as keyof typeof P) >= 1 && x.r[k].trades / days(k as keyof typeof P) <= 6));
active.sort((a, b) => worstDev(b) - worstDev(a));
console.log(`Active configs: ${active.length}. Top 6 by the weaker development half:`);
for (const x of active.slice(0, 6)) console.log('  ' + fmt(x));
