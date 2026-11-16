/**
 * Backtests the BTC bot with an AI early exit: entries stay on 4-hour candles, and an open trade is
 * closed when the trend model (scripts/ml/trend_model.py, walk-forward, out-of-sample) says a real
 * trend against it has started. Settings are chosen on the development period only, then checked
 * on validation and test.
 *
 *   DATA=BTCUSDT.csv ML=ml_dir npx vite-node scripts/ml-exit-research.ts -- out.json
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestStats, type SignalSeries } from '../src/engine/backtest';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const PERIODS = {
  dev: [utc('2025-05-01T00:00:00'), utc('2026-04-01T00:00:00')],
  val: [utc('2026-04-01T00:00:00'), utc('2026-10-07T00:00:00')],
  test: [utc('2026-10-07T00:00:00'), utc('2026-10-27T02:28:00')],
} as const;

function csv(path: string) {
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.slice(1).filter(Boolean).map((l) => l.split(',').map(Number));
}

const base: Candle[] = csv(process.env.DATA!).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
const bars4h = aggregate(base, tfSeconds('4h'));
const sig4h = computeSignals(SETTINGS.strategy, bars4h, Math.max(0, lowerBound(bars4h, PERIODS.dev[0]) - 1));
const bars15 = aggregate(base, 900);

/** The model's view as a score: +100 sure of an uptrend, −100 sure of a downtrend. */
function modelSeries(file: string): SignalSeries {
  const n = bars15.length;
  const s: SignalSeries = { score: new Int16Array(n), ready: new Uint8Array(n), atrPct: new Float64Array(n).fill(NaN), trend: new Int8Array(n) };
  for (const [time, pDown, pUp] of csv(file)) {
    const i = lowerBound(bars15, time);
    if (i < n && bars15[i].time === time) {
      s.score[i] = Math.round(100 * (pUp - pDown));
      s.ready[i] = 1;
    }
  }
  return s;
}

const pick = (s: BacktestStats) => ({
  ret: +s.returnPct.toFixed(1),
  dd: +s.maxDrawdownPct.toFixed(1),
  trades: s.trades,
  win: +s.winRate.toFixed(0),
  fees: +s.fees.toFixed(0),
  worst: +s.worst.toFixed(0),
});

function run(settings: BotSettings, earlyExit?: Parameters<typeof runBacktest>[0]['earlyExit']) {
  const one = ([start, end]: readonly [number, number]) =>
    pick(runBacktest({ base, start, end, timeframe: '4h', settings, startCash: 10_000, bars: bars4h, signals: sig4h, earlyExit, quiet: true }).stats);
  return { dev: one(PERIODS.dev), val: one(PERIODS.val), test: one(PERIODS.test) };
}

const rows: { name: string; dev: ReturnType<typeof pick>; val: ReturnType<typeof pick>; test: ReturnType<typeof pick> }[] = [];
rows.push({ name: 'Current bot', ...run(SETTINGS) });
for (const file of readdirSync(process.env.ML!).filter((f) => f.endsWith('.csv')).sort()) {
  const signals = modelSeries(`${process.env.ML}/${file}`);
  for (const threshold of [20, 40, 60])
    for (const hours of [4, 12]) {
      const settings = { ...SETTINGS, cooldownSec: hours * 3600 };
      rows.push({ name: `${file.replace('.csv', '')} exit at ${threshold}, wait ${hours}h`, ...run(settings, { bars: bars15, signals, seconds: 900, threshold }) });
    }
}
for (const r of rows) process.stderr.write(`${r.name.padEnd(36)} dev ${r.dev.ret}% (${r.dev.trades} tr, dd ${r.dev.dd}%)  val ${r.val.ret}% (${r.val.trades} tr)  test ${r.test.ret}%\n`);
writeFileSync(process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'ml-exit.json', JSON.stringify(rows, null, 2));
