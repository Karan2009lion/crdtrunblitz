/**
 * Blitz, part 3: let winners run. $150 with $30 a trade, 2-hour sessions, one a day at four times
 * of day. Instead of selling at a fixed target, a trade is held while the chart stays good: a stop
 * that trails behind the best price, or a sale when the chart turns. Chosen on the older period,
 * checked on the newer one and the hidden days. Session stop at −2% ($3).
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/blitz-hold-research.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { CLASSIC_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, type BacktestTimeframe, type SignalSeries } from '../src/engine/backtest';

const [outPath = 'blitz-hold-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
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
const CASH = 150;

const BLITZ: BotSettings = {
  ...CLASSIC_SETTINGS,
  sizing: 'fixed',
  tradeAmount: 30,
  budget: CASH,
  maxLoss: 3,
  allowShort: true,
  trendFilter: false,
  feeFilter: false,
  stopMode: 'percent',
  cooldownSec: 60,
  maxTradesPerMinute: 1,
  maxHoldMin: 0,
};
type V = [string, StrategyId, BacktestTimeframe, Partial<BotSettings>];
const VARIANTS: V[] = [
  ['now: 1 min, score 30, stop 0.3%, target 0.45%, 15 min', 'smart', '1m', { minConfidence: 30, stopLossPct: 0.3, takeProfitPct: 0.45, maxHoldMin: 15, trailingStop: false, exitOnSignal: false }],
  ['1 min, score 30, trailing stop 0.3%', 'smart', '1m', { minConfidence: 30, stopLossPct: 0.3, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
  ['1 min, score 30, trailing stop 0.5%', 'smart', '1m', { minConfidence: 30, stopLossPct: 0.5, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
  ['1 min, score 30, stop 0.4%, sell when the chart turns', 'smart', '1m', { minConfidence: 30, stopLossPct: 0.4, takeProfitPct: 0, trailingStop: false, exitOnSignal: true }],
  ['1 min, score 50, trailing stop 0.5%', 'smart', '1m', { minConfidence: 50, stopLossPct: 0.5, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
  ['5 min, score 30, trailing stop 0.5%', 'smart', '5m', { minConfidence: 30, stopLossPct: 0.5, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
  ['5 min, score 30, trailing stop 0.8%', 'smart', '5m', { minConfidence: 30, stopLossPct: 0.8, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
  ['5 min, score 30, stop 0.6%, sell when the chart turns', 'smart', '5m', { minConfidence: 30, stopLossPct: 0.6, takeProfitPct: 0, trailingStop: false, exitOnSignal: true }],
  ['5 min momentum, score 50, trailing stop 0.6%', 'macd', '5m', { minConfidence: 50, stopLossPct: 0.6, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
  ['5 min trend, score 50, trailing stop 0.6%', 'ema', '5m', { minConfidence: 50, stopLossPct: 0.6, takeProfitPct: 0, trailingStop: true, exitOnSignal: false }],
];

const SEC: Record<string, number> = { '1m': 60, '5m': 300 };
const series: Record<string, { bars: Candle[]; sig: Partial<Record<StrategyId, SignalSeries>> }> = {};
const out: Record<string, unknown> = {};
for (const [name, strat, tf, extra] of VARIANTS) {
  const sec = SEC[tf];
  const s = (series[tf] ??= { bars: sec === 60 ? base : aggregate(base, sec), sig: {} });
  const signals = (s.sig[strat] ??= computeSignals(strat, s.bars, Math.max(0, lowerBound(s.bars, P.older[0] - 400 * sec))));
  const st: BotSettings = { ...BLITZ, strategy: strat, ...extra };
  const line: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [k, [a, z]] of Object.entries(P)) {
    const res: { pnl: number; trades: number; fees: number }[] = [];
    for (const h of [2, 8, 13, 20]) {
      for (let d = Math.floor(a / 86400) * 86400; d + 86400 <= z; d += 86400) {
        const s0 = d + h * 3600;
        if (s0 < a) continue;
        const r = runBacktest({ base, start: s0, end: s0 + 7200, timeframe: tf, settings: st, startCash: CASH, bars: s.bars, signals, quiet: true });
        res.push({ pnl: r.stats.netPnl, trades: r.stats.trades, fees: r.stats.fees });
      }
    }
    const p = res.map((x) => x.pnl).sort((x, y) => x - y);
    const n = res.length;
    const sum = (f: (x: (typeof res)[number]) => number) => res.reduce((acc, x) => acc + f(x), 0);
    line[k] = {
      sessions: n,
      avg: +(sum((x) => x.pnl) / n).toFixed(3),
      median: +p[n >> 1].toFixed(3),
      worst: +p[0].toFixed(2),
      best: +p[n - 1].toFixed(2),
      up: Math.round((100 * p.filter((x) => x > 0).length) / n),
      trades: +(sum((x) => x.trades) / n).toFixed(1),
      fees: +(sum((x) => x.fees) / n).toFixed(3),
      beforeFees: +(sum((x) => x.pnl + x.fees) / n).toFixed(3),
    };
    const L = line[k] as Record<string, number>;
    parts.push(`${k}: avg ${L.avg >= 0 ? '+' : ''}$${L.avg.toFixed(3)} a session (before fees ${L.beforeFees >= 0 ? '+' : ''}$${L.beforeFees.toFixed(3)}), median $${L.median.toFixed(3)}, worst $${L.worst}, best $${L.best}, up ${L.up}% · ${L.trades} trades`);
  }
  out[name] = line;
  console.log(`${name}\n   ${parts.join('\n   ')}`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
}
