/**
 * Walk-forward research over a long CSV of 1-minute candles.
 *
 *   npx vite-node scripts/research.ts -- grid <v1|v2> <part> <parts> <out.json>
 *   npx vite-node scripts/research.ts -- eval <configs.json> <out.json>
 *
 * Settings are chosen on the development period only (two halves, so they must work in both),
 * checked on the validation period, and run once on the final test window.
 * Set DATA to the CSV path (timestamp,open,high,low,close,volume).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { CLASSIC_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestStats, type BacktestTimeframe } from '../src/engine/backtest';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
type Window = readonly [number, number];
const DEV_START = utc('2025-03-01T00:00:00');
const DEV_MID = utc('2025-09-15T00:00:00');
const VAL_START = utc('2026-04-01T00:00:00');
/** The final test is the last 20 days of data, ending no later than this. */
const LATEST_END = utc('2026-10-27T02:28:00');

function periodsFor(dataEnd: number) {
  const end = Math.min(LATEST_END, dataEnd);
  const testStart = end - 20 * 86400;
  return {
    devA: [DEV_START, DEV_MID] as Window,
    devB: [DEV_MID, VAL_START] as Window,
    dev: [DEV_START, VAL_START] as Window,
    val: [VAL_START, testStart] as Window,
    test: [testStart, end] as Window,
    all: [DEV_START, end] as Window,
  };
}
let PERIODS = periodsFor(LATEST_END);

const BASE: BotSettings = {
  ...CLASSIC_SETTINGS,
  symbols: ['BTCUSDT'],
  tradeAmount: 10_000,
  budget: 10_000,
  maxLoss: 0, // judged over months, so no session stop
  profitTarget: 0,
};

function load(): Candle[] {
  const text = readFileSync(process.env.DATA!, 'utf8');
  const out: Candle[] = [];
  let i = text.indexOf('\n') + 1;
  while (i < text.length) {
    const j = text.indexOf('\n', i);
    const line = text.slice(i, j < 0 ? undefined : j);
    i = j < 0 ? text.length : j + 1;
    const p = line.split(',');
    if (p.length < 6) continue;
    out.push({ time: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  return out;
}

export interface Config {
  strategy: StrategyId;
  timeframe: BacktestTimeframe;
  settings: Partial<BotSettings>;
}

function* grid(kind: 'v1' | 'v2'): Generator<Config> {
  const tfs: BacktestTimeframe[] = ['15m', '1h', '4h'];
  if (kind === 'v1') {
    for (const strategy of ['smart', 'ema', 'rsi', 'bollinger', 'macd'] as StrategyId[])
      for (const timeframe of tfs)
        for (const minConfidence of [40, 50, 60, 70])
          for (const stopLossPct of [0.5, 1, 2, 3])
            for (const takeProfitPct of [0, 1, 2, 4])
              for (const trailingStop of [true, false])
                for (const allowShort of [false, true])
                  yield { strategy, timeframe, settings: { minConfidence, stopLossPct, takeProfitPct, trailingStop, allowShort } };
    return;
  }
  for (const strategy of ['smart', 'ema', 'rsi', 'bollinger', 'macd', 'breakout', 'pullback'] as StrategyId[])
    for (const timeframe of tfs)
      for (const minConfidence of [50, 70])
        for (const stopAtr of [1.5, 2.5, 4])
          for (const targetAtr of [0, 3, 6])
            for (const trailingStop of [true, false])
              for (const trendFilter of [true, false])
                for (const exitOnSignal of [true, false])
                  for (const allowShort of [false, true])
                    yield {
                      strategy,
                      timeframe,
                      settings: { minConfidence, stopMode: 'atr', stopAtr, targetAtr, trailingStop, trendFilter, exitOnSignal, allowShort, feeFilter: true },
                    };
}

const prep = new Map<string, { bars: Candle[]; signals: ReturnType<typeof computeSignals> }>();
function prepared(base: Candle[], strategy: StrategyId, timeframe: BacktestTimeframe) {
  const key = `${strategy}:${timeframe}`;
  let p = prep.get(key);
  if (!p) {
    const bars = aggregate(base, tfSeconds(timeframe));
    const from = Math.max(0, lowerBound(bars, PERIODS.dev[0]) - 1);
    const t0 = Date.now();
    p = { bars, signals: computeSignals(strategy, bars, from) };
    process.stderr.write(`  signals ${key} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    prep.clear(); // configs arrive grouped, so keep only the current series in memory
    prep.set(key, p);
  }
  return p;
}

export function run(base: Candle[], c: Config, [start, end]: Window, quiet = true) {
  const p = prepared(base, c.strategy, c.timeframe);
  const settings: BotSettings = { ...BASE, ...c.settings, strategy: c.strategy };
  return runBacktest({ base, start, end, timeframe: c.timeframe, settings, startCash: 10_000, bars: p.bars, signals: quiet ? p.signals : undefined, quiet });
}

const pick = (s: BacktestStats) => ({
  ret: +s.returnPct.toFixed(3),
  dd: +s.maxDrawdownPct.toFixed(2),
  trades: s.trades,
  win: +s.winRate.toFixed(1),
  pf: Number.isFinite(s.profitFactor) ? +s.profitFactor.toFixed(2) : 99,
  fees: +s.fees.toFixed(0),
  bh: +s.buyHoldPct.toFixed(2),
});

const [mode, ...args] = process.argv.slice(2).filter((a) => a !== '--');
const base = load();
PERIODS = periodsFor(base[base.length - 1].time + 60);
process.stderr.write(`loaded ${base.length} candles; test window ${new Date(PERIODS.test[0] * 1000).toISOString()} – ${new Date(PERIODS.test[1] * 1000).toISOString()}\n`);

if (mode === 'grid') {
  const [kind, partS, partsS, out] = args;
  const part = +partS;
  const parts = +partsS;
  const all = [...grid(kind as 'v1' | 'v2')];
  // Split by (strategy, timeframe) groups so each process computes each signal series once.
  const groups = [...new Set(all.map((c) => `${c.strategy}:${c.timeframe}`))];
  const mine = new Set(groups.filter((_, i) => i % parts === part));
  const rows = [];
  let n = 0;
  for (const c of all) {
    if (!mine.has(`${c.strategy}:${c.timeframe}`)) continue;
    const a = run(base, c, PERIODS.devA).stats;
    const b = run(base, c, PERIODS.devB).stats;
    const v = run(base, c, PERIODS.val).stats;
    rows.push({ c, devA: pick(a), devB: pick(b), val: pick(v) });
    if (++n % 200 === 0) process.stderr.write(`  part ${part}: ${n} configs\n`);
  }
  writeFileSync(out, JSON.stringify(rows));
  process.stderr.write(`part ${part} done: ${rows.length} configs\n`);
} else if (mode === 'eval') {
  const [cfgPath, out] = args;
  const configs: { name: string; c: Config }[] = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const res = configs.map(({ name, c }) => {
    const per: Record<string, unknown> = {};
    for (const k of (process.env.PERIODS ?? 'dev,val,test').split(',') as (keyof typeof PERIODS)[]) {
      const r = run(base, c, PERIODS[k], false);
      per[k] = {
        stats: pick(r.stats),
        full: r.stats,
        equity: r.equity,
        trades: r.trades,
        monthly: monthly(r.equity),
      };
    }
    process.stderr.write(`  evaluated ${name}\n`);
    return { name, c, ...per };
  });
  writeFileSync(out, JSON.stringify(res));
}

/** Month-by-month return from an hourly equity curve. */
function monthly(eq: { time: number; value: number }[]) {
  const out: { month: string; ret: number }[] = [];
  let startVal = 10_000;
  let cur = '';
  let lastVal = 10_000;
  for (const p of eq) {
    const m = new Date(p.time * 1000).toISOString().slice(0, 7);
    if (m !== cur) {
      if (cur) out.push({ month: cur, ret: ((lastVal - startVal) / startVal) * 100 });
      cur = m;
      startVal = lastVal;
    }
    lastVal = p.value;
  }
  if (cur) out.push({ month: cur, ret: ((lastVal - startVal) / startVal) * 100 });
  return out;
}
