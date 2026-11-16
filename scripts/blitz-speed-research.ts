/**
 * Blitz, part 2: how quick can it be? Faster settings (a lower signal threshold, a tighter stop and
 * target, shorter holds) give more trades per 2-hour session but pay more fees. One session a day
 * at four times of day, Apr – Oct 2026 and the hidden days, 0.25% of the account at risk a trade,
 * session stop at −2%.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/blitz-speed-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { CLASSIC_SETTINGS } from '../src/store/useStore';
import { computeSignals, lowerBound, runBacktest, type SignalSeries } from '../src/engine/backtest';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const P: Record<string, [number, number]> = { newer: [utc('2026-04-01T00:00:00'), utc('2026-10-27T00:00:00')] };
if (process.env.HIDDEN_FROM) P.hidden = [Number(process.env.HIDDEN_FROM), base[base.length - 1].time + 60];

const QUICK: BotSettings = {
  ...CLASSIC_SETTINGS,
  sizing: 'risk',
  riskPct: 0.25,
  tradeAmount: Number.MAX_SAFE_INTEGER,
  budget: Number.MAX_SAFE_INTEGER,
  maxLoss: 200,
  allowShort: true,
  trailingStop: false,
  trendFilter: false,
  feeFilter: false,
  exitOnSignal: false,
  stopMode: 'percent',
  cooldownSec: 60,
  maxTradesPerMinute: 1,
};
const V: [string, StrategyId, Partial<BotSettings>][] = [
  ['pullback, score 50, stop 0.3% / target 0.45%, 30 min', 'pullback', { minConfidence: 50, stopLossPct: 0.3, takeProfitPct: 0.45, maxHoldMin: 30 }],
  ['smart, score 50, stop 0.5% / target 0.75%, 60 min', 'smart', { minConfidence: 50, stopLossPct: 0.5, takeProfitPct: 0.75, maxHoldMin: 60 }],
  ['smart, score 30, stop 0.3% / target 0.45%, 15 min', 'smart', { minConfidence: 30, stopLossPct: 0.3, takeProfitPct: 0.45, maxHoldMin: 15 }],
  ['pullback, score 30, stop 0.2% / target 0.3%, 10 min', 'pullback', { minConfidence: 30, stopLossPct: 0.2, takeProfitPct: 0.3, maxHoldMin: 10 }],
  ['bollinger, score 30, stop 0.2% / target 0.3%, 10 min', 'bollinger', { minConfidence: 30, stopLossPct: 0.2, takeProfitPct: 0.3, maxHoldMin: 10 }],
  ['macd, score 30, stop 0.2% / target 0.3%, 10 min', 'macd', { minConfidence: 30, stopLossPct: 0.2, takeProfitPct: 0.3, maxHoldMin: 10 }],
  ['ema, score 30, stop 0.2% / target 0.3%, 10 min', 'ema', { minConfidence: 30, stopLossPct: 0.2, takeProfitPct: 0.3, maxHoldMin: 10 }],
  ['smart, score 20, stop 0.2% / target 0.3%, 10 min', 'smart', { minConfidence: 20, stopLossPct: 0.2, takeProfitPct: 0.3, maxHoldMin: 10 }],
];
const from = Math.max(0, lowerBound(base, P.newer[0] - 400 * 60));
const cache: Partial<Record<StrategyId, SignalSeries>> = {};
for (const [name, strat, extra] of V) {
  const signals = (cache[strat] ??= computeSignals(strat, base, from));
  const st: BotSettings = { ...QUICK, strategy: strat, ...extra };
  const parts: string[] = [];
  for (const [k, [a, z]] of Object.entries(P)) {
    const res: { ret: number; trades: number }[] = [];
    for (const h of [2, 8, 13, 20]) {
      for (let d = Math.floor(a / 86400) * 86400; d + 86400 <= z; d += 86400) {
        const s0 = d + h * 3600;
        if (s0 < a) continue;
        const r = runBacktest({ base, start: s0, end: s0 + 7200, timeframe: '1m', settings: st, startCash: 10_000, bars: base, signals, quiet: true });
        res.push({ ret: r.stats.returnPct, trades: r.stats.trades });
      }
    }
    const rets = res.map((x) => x.ret).sort((x, y) => x - y);
    const avg = rets.reduce((x, y) => x + y, 0) / rets.length;
    const tps = res.reduce((x, y) => x + y.trades, 0) / res.length;
    parts.push(`${k}: ${tps.toFixed(1)} trades a session, avg ${avg.toFixed(2)}%, median ${rets[rets.length >> 1].toFixed(2)}%, worst ${rets[0].toFixed(2)}%, best ${rets[rets.length - 1].toFixed(2)}%, up ${Math.round((100 * rets.filter((x) => x > 0).length) / rets.length)}%`);
  }
  console.log(`${name}\n   ${parts.join('\n   ')}`);
}
