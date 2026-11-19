/**
 * Can deciding every 2 hours beat deciding every 4 hours, under the same conditions? The trader's
 * momentum rules on 2-hour and 4-hour candles, 0.5% of the account at risk a trade, buys and
 * shorts, 0.1% fees and 0.02% slippage. First with the 4-hour bot's exact rules, then with the
 * stop, target and signal strength tuned on the older period only, checked on the newer period
 * and the hidden days.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/two-hour-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { TRADER_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestTimeframe } from '../src/engine/backtest';

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

function run(tf: BacktestTimeframe, bars: Candle[], signals: ReturnType<typeof computeSignals>, st: BotSettings, [a, z]: [number, number]) {
  const r = runBacktest({ base, start: a, end: z, timeframe: tf, settings: st, startCash: 10_000, bars, signals, quiet: true });
  // 15-day windows from the account curve.
  const eq = r.equity;
  const at = (t: number) => {
    let v = 10_000;
    for (const p of eq) {
      if (p.time > t) break;
      v = p.value;
    }
    return v;
  };
  const w: number[] = [];
  for (let t = a; t + 15 * 86400 <= z; t += 15 * 86400) w.push((at(t + 15 * 86400) / at(t) - 1) * 100);
  return { ret: r.stats.returnPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, won: r.stats.wins, up15: w.length ? Math.round((100 * w.filter((x) => x > 0).length) / w.length) : null };
}
const fmt = (x: ReturnType<typeof run>) => `${x.ret >= 0 ? '+' : ''}${x.ret.toFixed(1)}% (${x.trades} trades, ${x.won} won, drop ${x.dd.toFixed(1)}%${x.up15 !== null ? `, 15-day windows up ${x.up15}%` : ''})`;

for (const tf of ['4h', '2h'] as BacktestTimeframe[]) {
  const sec = tfSeconds(tf);
  const bars = aggregate(base, sec);
  const signals = computeSignals('macd', bars, Math.max(0, lowerBound(bars, P.older[0]) - 400));
  console.log(`\n${tf} candles`);
  const same = Object.entries(P).map(([k, p]) => `${k} ${fmt(run(tf, bars, signals, TRADER_SETTINGS, p))}`);
  console.log(`  the 4-hour bot's rules:  ${same.join(' | ')}`);
  // Tune on the older period only.
  const grid: { st: BotSettings; label: string; score: number }[] = [];
  for (const stopAtr of [2, 2.5, 3, 4])
    for (const targetAtr of [4, 6, 8, 10])
      for (const minConfidence of [50, 60]) {
        const st: BotSettings = { ...TRADER_SETTINGS, stopAtr, targetAtr, minConfidence };
        const r = run(tf, bars, signals, st, P.older);
        grid.push({ st, label: `stop ${stopAtr}× ATR, target ${targetAtr}× ATR, score ${minConfidence}`, score: r.ret - 0.5 * r.dd });
      }
  grid.sort((x, y) => y.score - x.score);
  for (const g of grid.slice(0, 3)) {
    const res = Object.entries(P).map(([k, p]) => `${k} ${fmt(run(tf, bars, signals, g.st, p))}`);
    console.log(`  tuned: ${g.label}\n      ${res.join(' | ')}`);
  }
}
