/**
 * Picks settings for the app's Live mode: the chart reader on 1-minute candles, buying when every
 * check passes and selling as soon as the chart turns or at the stop. Runs 10-day paper tests
 * started every 10 days over 20 months of 1-minute BTC prices, with and without fees.
 *
 * Findings (Nov 2026): before fees the checklist broke even (median about 0%), so fees decide the
 * result: the more it trades, the more it loses. Over 6-month periods every setting lost 75% (the
 * point where the bot stops buying). The app uses move >= 0.1%, stop 1.5 ATR, no target, 15-minute wait.
 *
 *   DATA=BTCUSDT.csv npx vite-node scripts/live-mode-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { SETTINGS } from '../src/store/useStore';
import { lowerBound, runBacktest, type SignalSeries } from '../src/engine/backtest';
import { CHART_RULES, readChart } from '../src/lib/chartRules';
const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => { const [time, open, high, low, close, volume] = l.split(',').map(Number); return { time, open, high, low, close, volume }; });
const A = utc('2025-03-01T00:00:00'), Z = utc('2026-10-27T02:28:00');
const from = lowerBound(base, A) - 1, n = base.length;
const raw = new Int16Array(n), atrPct = new Float64Array(n).fill(NaN), ready = new Uint8Array(n);
for (let i = from; i < n; i++) { const r = readChart(base.slice(Math.max(0, i - 299), i + 1), { ...CHART_RULES, minMovePct: 0, minSteadiness: 0, bigTrend: false, exitBufferAtr: 0, trendExit: true }); raw[i] = r.action === 'buy' ? 100 : r.action === 'sell' ? -100 : 0; ready[i] = r.ready ? 1 : 0; atrPct[i] = r.atrPct ?? NaN; }
const series = (m: number): SignalSeries => { const score = new Int16Array(n); for (let i = 0; i < n; i++) score[i] = raw[i] === 100 && !(atrPct[i] >= m) ? 0 : raw[i]; return { score, ready, atrPct, trend: new Int8Array(n), verdicts: true }; };
// Ten-day paper tests started every 10 days, like the user's test.
const starts: number[] = []; for (let d = A; d + 10 * 86400 <= Z; d += 10 * 86400) starts.push(d);
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const minMove of [0.04, 0.06, 0.08, 0.1, 0.15]) {
  const signals = series(minMove);
  for (const [stopAtr, targetAtr] of [[1.5, 0], [2, 3], [3, 6]]) for (const cool of [3, 15]) {
    const st: BotSettings = { ...SETTINGS, strategy: 'chart', minConfidence: 50, exitOnSignal: true, stopMode: 'atr', stopAtr, targetAtr, trailingStop: false, allowShort: false, feeFilter: false, cooldownSec: cool * 60, maxHoldMin: 0 };
    const ten: number[] = [], tpd: number[] = [], gross: number[] = [];
    for (const s0 of starts) {
      const r = runBacktest({ base, start: s0, end: s0 + 10 * 86400, timeframe: '1m', settings: st, startCash: 10_000, bars: base, signals, quiet: true });
      ten.push(r.stats.returnPct); tpd.push(r.stats.trades / 10);
      const g = runBacktest({ base, start: s0, end: s0 + 10 * 86400, timeframe: '1m', settings: { ...st, feePct: 0, slippagePct: 0 }, startCash: 10_000, bars: base, signals, quiet: true });
      gross.push(g.stats.returnPct);
    }
    console.log(`move ≥${minMove}% stop ${stopAtr} target ${targetAtr || '-'} wait ${cool}m: 10-day median ${med(ten).toFixed(1)}% (worst ${Math.min(...ten).toFixed(1)}%, best ${Math.max(...ten).toFixed(1)}%), ${med(tpd).toFixed(1)} trades/day | before fees median ${med(gross).toFixed(1)}%, positive ${Math.round((100 * gross.filter((x) => x > 0).length) / gross.length)}%`);
  }
}
