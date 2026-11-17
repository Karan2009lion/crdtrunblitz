/**
 * Why not aim for +10–15% a trade, so fees don't matter? Two checks on Binance 1-minute BTC prices:
 *   1. How far BTC moves (high to low) in 2 hours, 1 day, 1 week and 30 days: how often a 10% or
 *      15% move is even possible in that time.
 *   2. The 4-hour momentum trader with bigger targets (6 to 15 × the typical 4-hour move), and with
 *      no target at all behind a trailing stop. 0.5% of the account at risk a trade, fees included.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/target-size-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { TRADER_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest } from '../src/engine/backtest';

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

/* 1. How far BTC moves from where a window starts, in either direction. */
console.log('Largest move from the start price within the window (up or down), Mar 2025 – Nov 2026:');
for (const [name, minutes] of [['2 hours', 120], ['1 day', 1440], ['1 week', 10080], ['30 days', 43200]] as [string, number][]) {
  const moves: number[] = [];
  const step = Math.max(60, Math.floor(minutes / 4));
  for (let i = lowerBound(base, P.older[0]); i + minutes < base.length; i += step) {
    const start = base[i].open;
    let hi = start;
    let lo = start;
    for (let k = i; k < i + minutes; k++) {
      if (base[k].high > hi) hi = base[k].high;
      if (base[k].low < lo) lo = base[k].low;
    }
    moves.push(Math.max(hi / start - 1, 1 - lo / start) * 100);
  }
  moves.sort((a, b) => a - b);
  const share = (x: number) => ((100 * moves.filter((m) => m >= x).length) / moves.length).toFixed(1);
  console.log(`  ${name.padEnd(8)} typical ${moves[moves.length >> 1].toFixed(2)}%, 9 in 10 under ${moves[Math.floor(moves.length * 0.9)].toFixed(2)}% · reaches 1%: ${share(1)}% of the time, 5%: ${share(5)}%, 10%: ${share(10)}%, 15%: ${share(15)}%`);
}

/* 2. The 4-hour trader with bigger targets. */
const b4 = aggregate(base, 14_400);
const s4 = computeSignals('macd', b4, Math.max(0, lowerBound(b4, P.older[0]) - 1));
const variants: [string, Partial<BotSettings>][] = [
  ['target 6× ATR (now, about +7%)', { targetAtr: 6 }],
  ['target 9× ATR (about +10%)', { targetAtr: 9 }],
  ['target 12× ATR (about +14%)', { targetAtr: 12 }],
  ['target 15× ATR (about +17%)', { targetAtr: 15 }],
  ['no target, trailing stop', { targetAtr: 0, trailingStop: true }],
];
console.log('\n4-hour momentum trader, 0.5% at risk a trade, stop 2.5× ATR:');
for (const [name, extra] of variants) {
  const st: BotSettings = { ...TRADER_SETTINGS, ...extra };
  const parts: string[] = [];
  for (const [k, [a, z]] of Object.entries(P)) {
    const r = runBacktest({ base, start: a, end: z, timeframe: '4h', settings: st, startCash: 10_000, bars: b4, signals: s4, quiet: true });
    const won = r.trades.filter((t) => t.pnl > 0);
    const avgWin = won.length ? (won.reduce((x, t) => x + t.pnlPct, 0) / won.length).toFixed(1) : '–';
    const held = r.trades.length ? (r.trades.reduce((x, t) => x + (t.exitTime - t.entryTime), 0) / r.trades.length / 86_400_000).toFixed(1) : '–';
    parts.push(`${k}: ${r.stats.returnPct >= 0 ? '+' : ''}${r.stats.returnPct.toFixed(1)}% (${r.stats.trades} trades, ${won.length} won, avg win +${avgWin}% of the trade, held ${held} days, fees ${((r.stats.fees / 10_000) * 100).toFixed(2)}% of the account)`);
  }
  console.log(`  ${name}\n     ${parts.join('\n     ')}`);
}
