/**
 * Making the 4-hour trader the best it can be, without fitting the past. A grid of stop and
 * target distances, signal strength, the trend filter and selling when the signal reverses is
 * scored on the older period only (return minus half the biggest drop); the best few are then
 * run on the newer period and the hidden days, which the choice never saw. 0.5% at risk a trade,
 * buys and shorts, 0.1% fees and 0.02% slippage.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/four-hour-best-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { TRADER_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, type SignalSeries } from '../src/engine/backtest';

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
const bars = aggregate(base, 14_400);
const sigs: Partial<Record<StrategyId, SignalSeries>> = {};
const signalsFor = (s: StrategyId) => (sigs[s] ??= computeSignals(s, bars, Math.max(0, lowerBound(bars, P.older[0]) - 400)));

function run(st: BotSettings, [a, z]: [number, number]) {
  const r = runBacktest({ base, start: a, end: z, timeframe: '4h', settings: st, startCash: 10_000, bars, signals: signalsFor(st.strategy), quiet: true });
  return { ret: r.stats.returnPct, dd: r.stats.maxDrawdownPct, trades: r.stats.trades, won: r.stats.wins, worst: r.stats.worst };
}
const fmt = (x: ReturnType<typeof run>) => `${x.ret >= 0 ? '+' : ''}${x.ret.toFixed(1)}% (${x.trades} tr, ${x.won} won, drop ${x.dd.toFixed(1)}%, worst $${x.worst.toFixed(0)})`;
const show = (label: string, st: BotSettings) => console.log(`${label}\n   ${Object.entries(P).map(([k, p]) => `${k} ${fmt(run(st, p))}`).join(' | ')}`);

show('Current 4-hour bot (momentum, stop 2.5×, target 6×, score 50)', TRADER_SETTINGS);

const grid: { st: BotSettings; label: string; score: number }[] = [];
for (const strategy of ['macd', 'smart', 'ema', 'breakout'] as StrategyId[])
  for (const stopAtr of [2, 2.5, 3])
    for (const targetAtr of [4, 5, 6, 8])
      for (const minConfidence of [40, 50, 60])
        for (const trendFilter of [false, true])
          for (const exitOnSignal of [false, true]) {
            const st: BotSettings = { ...TRADER_SETTINGS, strategy, stopAtr, targetAtr, minConfidence, trendFilter, exitOnSignal };
            const r = run(st, P.older);
            if (r.trades < 20) continue;
            grid.push({
              st,
              label: `${strategy}, stop ${stopAtr}×, target ${targetAtr}×, score ${minConfidence}${trendFilter ? ', with the trend only' : ''}${exitOnSignal ? ', sells when the signal reverses' : ''}`,
              score: r.ret - 0.5 * r.dd,
            });
          }
grid.sort((x, y) => y.score - x.score);
console.log(`\n${grid.length} settings scored on the older period. The best 8, on the periods they never saw:`);
for (const g of grid.slice(0, 8)) show(`  ${g.label}`, g.st);
