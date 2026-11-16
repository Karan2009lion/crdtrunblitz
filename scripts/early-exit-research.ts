/**
 * Does an early exit help the BTC bot? Enters on 4-hour candles as now, but closes the trade as
 * soon as a faster chart (15m or 1h) turns against it. Compared with the current settings and
 * with tighter stops, on the same development, validation and test periods as research.ts.
 *
 *   DATA=BTCUSDT.csv npx vite-node scripts/early-exit-research.ts -- out.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestStats, type BacktestTimeframe } from '../src/engine/backtest';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const DEV: [number, number] = [utc('2025-03-01T00:00:00'), utc('2026-04-01T00:00:00')];
const TEST_END = utc('2026-10-27T02:28:00');
const VAL: [number, number] = [DEV[1], TEST_END - 20 * 86400];
const TEST: [number, number] = [VAL[1], TEST_END];

function load(): Candle[] {
  const text = readFileSync(process.env.DATA!, 'utf8');
  const out: Candle[] = [];
  for (const line of text.split('\n').slice(1)) {
    const p = line.split(',');
    if (p.length >= 6) out.push({ time: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  return out;
}

const base = load();
const bars4h = aggregate(base, tfSeconds('4h'));
const sig4h = computeSignals(SETTINGS.strategy, bars4h, Math.max(0, lowerBound(bars4h, DEV[0]) - 1));

const fast = new Map<string, { bars: Candle[]; signals: ReturnType<typeof computeSignals>; seconds: number }>();
function fastSeries(strategy: StrategyId, tf: BacktestTimeframe) {
  const key = `${strategy}:${tf}`;
  if (!fast.has(key)) {
    const seconds = tfSeconds(tf);
    const bars = aggregate(base, seconds);
    fast.set(key, { bars, seconds, signals: computeSignals(strategy, bars, Math.max(0, lowerBound(bars, DEV[0]) - 1)) });
  }
  return fast.get(key)!;
}

interface Variant {
  name: string;
  settings?: Partial<BotSettings>;
  exit?: { strategy: StrategyId; tf: BacktestTimeframe; threshold: number };
}

const variants: Variant[] = [{ name: 'Current bot (stop 2.5 ATR, target 6 ATR)' }];
for (const tf of ['15m', '1h'] as BacktestTimeframe[])
  for (const strategy of ['macd', 'ema', 'smart'] as StrategyId[])
    for (const threshold of [1, 25, 50])
      variants.push({ name: `Exit when ${tf} ${strategy} score turns ${threshold === 1 ? 'negative at all' : `past ∓${threshold}`}`, exit: { strategy, tf, threshold } });
// After an early exit, wait before buying again, so the bot doesn't re-enter on the same signal.
for (const tf of ['15m', '1h'] as BacktestTimeframe[])
  for (const strategy of ['macd', 'smart'] as StrategyId[])
    for (const threshold of [1, 50])
      for (const hours of [4, 12, 24])
        variants.push({
          name: `Exit on ${tf} ${strategy} ${threshold === 1 ? '< 0' : `past ∓${threshold}`}, then wait ${hours}h`,
          exit: { strategy, tf, threshold },
          settings: { cooldownSec: hours * 3600 },
        });
for (const stopAtr of [1, 1.5]) variants.push({ name: `Tighter stop: ${stopAtr} ATR`, settings: { stopAtr } });
variants.push({ name: 'Trailing stop on', settings: { trailingStop: true } });
variants.push({ name: 'Exit on 4h signal flip', settings: { exitOnSignal: true } });

const pick = (s: BacktestStats) => ({
  ret: +s.returnPct.toFixed(1),
  dd: +s.maxDrawdownPct.toFixed(1),
  trades: s.trades,
  win: +s.winRate.toFixed(0),
  fees: +s.fees.toFixed(0),
  worst: +s.worst.toFixed(0),
});

const rows = variants.map((v) => {
  const settings: BotSettings = { ...SETTINGS, ...v.settings };
  const earlyExit = v.exit ? { ...fastSeries(v.exit.strategy, v.exit.tf), threshold: v.exit.threshold } : undefined;
  const run = ([start, end]: [number, number]) =>
    pick(runBacktest({ base, start, end, timeframe: '4h', settings, startCash: 10_000, bars: bars4h, signals: sig4h, earlyExit, quiet: true }).stats);
  const row = { name: v.name, dev: run(DEV), val: run(VAL), test: run(TEST) };
  process.stderr.write(`${row.name.padEnd(48)} dev ${row.dev.ret}% (${row.dev.trades} tr, dd ${row.dev.dd}%)  val ${row.val.ret}% (${row.val.trades} tr)  test ${row.test.ret}%\n`);
  return row;
});
writeFileSync(process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'early-exit.json', JSON.stringify(rows, null, 2));
