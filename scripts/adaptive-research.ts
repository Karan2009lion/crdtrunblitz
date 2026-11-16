/**
 * Research for adaptive mode.
 *
 *   DATA=ETHUSDT.csv npx vite-node scripts/adaptive-research.ts -- shadow <part> <parts> <out.json>
 *   DATA=ETHUSDT.csv npx vite-node scripts/adaptive-research.ts -- meta <out.json> <shadow parts...>
 *
 * "shadow" runs every candidate setting continuously and keeps its daily account value and trades.
 * "meta" tests adaptive rules that follow recently successful candidates, on the development
 * period (where the rule is chosen), the later unseen period and the final 20 days.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { CLASSIC_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestTimeframe } from '../src/engine/backtest';
import { tunedSettings, DEFAULT_GRID, type Tuned } from '../src/engine/optimizer';
import { DAY, DEFAULT_ADAPTIVE, simulateAdaptive, type AdaptiveOptions, type ShadowRun } from '../src/engine/adaptive';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const SHADOW_START = utc('2025-02-05T00:00:00');
const DEV: [number, number] = [utc('2025-05-10T00:00:00'), utc('2026-04-01T00:00:00')];
const VAL_START = utc('2026-04-01T00:00:00');

const BASE: BotSettings = { ...CLASSIC_SETTINGS, symbols: ['X'], tradeAmount: 10_000, budget: 10_000, maxLoss: 0, profitTarget: 0 };

function load(): Candle[] {
  const text = readFileSync(process.env.DATA!, 'utf8');
  const out: Candle[] = [];
  for (const line of text.split('\n')) {
    const p = line.split(',');
    if (p.length < 6 || !/^\d/.test(p[0])) continue;
    out.push({ time: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  return out;
}

function* grid(): Generator<Tuned> {
  const g = DEFAULT_GRID;
  for (const timeframe of g.timeframe)
    for (const strategy of g.strategy)
      for (const minConfidence of g.minConfidence)
        for (const stopAtr of g.stopAtr)
          for (const targetAtr of g.targetAtr)
            for (const trailingStop of g.trailingStop)
              for (const trendFilter of g.trendFilter)
                for (const exitOnSignal of g.exitOnSignal)
                  for (const allowShort of g.allowShort) yield { strategy, timeframe, minConfidence, stopAtr, targetAtr, trailingStop, trendFilter, exitOnSignal, allowShort };
}

const [mode, ...args] = process.argv.slice(2).filter((a) => a !== '--');
const base = load();
const dataEnd = base[base.length - 1].time + 60;
process.stderr.write(`loaded ${base.length} candles\n`);

if (mode === 'shadow') {
  const [partS, partsS, out] = args;
  const all = [...grid()];
  const groups = [...new Set(all.map((t) => `${t.strategy}:${t.timeframe}`))];
  const mine = new Set(groups.filter((_, i) => i % +partsS === +partS));
  let prepKey = '';
  let prep: { bars: Candle[]; signals: ReturnType<typeof computeSignals> } | null = null;
  const runs: (ShadowRun & { tuned: Tuned })[] = [];
  all.forEach((tuned, id) => {
    const key = `${tuned.strategy}:${tuned.timeframe}`;
    if (!mine.has(key)) return;
    if (key !== prepKey) {
      const bars = aggregate(base, tfSeconds(tuned.timeframe as BacktestTimeframe));
      prep = { bars, signals: computeSignals(tuned.strategy as StrategyId, bars, Math.max(0, lowerBound(bars, SHADOW_START) - 1)) };
      prepKey = key;
    }
    const r = runBacktest({
      base,
      start: SHADOW_START,
      end: dataEnd,
      timeframe: tuned.timeframe,
      settings: tunedSettings(BASE, tuned),
      startCash: 10_000,
      bars: prep!.bars,
      signals: prep!.signals,
      quiet: true,
    });
    const daily: number[] = [];
    let k = 0;
    let last = 10_000;
    for (let t = SHADOW_START + DAY; t <= dataEnd; t += DAY) {
      while (k < r.equity.length && r.equity[k].time <= t) last = r.equity[k++].value;
      daily.push(Math.round(last * 100) / 100);
    }
    const trades = r.trades.map((t) => [t.entryTime / 1000, t.exitTime / 1000, t.side === 'long' ? 1 : -1, +t.entryPrice.toPrecision(8), +t.exitPrice.toPrecision(8)] as ShadowRun['trades'][number]);
    runs.push({ id, tuned, daily, trades });
    if (runs.length % 300 === 0) process.stderr.write(`  part ${partS}: ${runs.length}\n`);
  });
  writeFileSync(out, JSON.stringify(runs));
  process.stderr.write(`part ${partS} done: ${runs.length}\n`);
} else if (mode === 'meta') {
  const [out, ...files] = args;
  const runs: (ShadowRun & { tuned: Tuned })[] = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
  const testEnd = dataEnd;
  const testStart = testEnd - 20 * DAY;
  const periods = { dev: DEV, val: [VAL_START, testStart] as [number, number], test: [testStart, testEnd] as [number, number] };
  const pools = {
    all: runs,
    slow: runs.filter((r) => r.tuned.timeframe !== '15m'),
  };
  const variants: { name: string; pool: keyof typeof pools; o: AdaptiveOptions }[] = [];
  for (const pool of ['all', 'slow'] as const)
    for (const windowDays of [30, 60, 90])
      for (const topK of [1, 3])
        for (const ddPenalty of [0, 0.5])
          variants.push({ name: `${pool}-w${windowDays}-k${topK}-dd${ddPenalty}`, pool, o: { ...DEFAULT_ADAPTIVE, windowDays, topK, ddPenalty } });
  const results = variants.map((v) => {
    const per: Record<string, unknown> = {};
    for (const [k, [s, e]] of Object.entries(periods)) {
      const r = simulateAdaptive(base, pools[v.pool], SHADOW_START, s, e, v.o);
      per[k] = { ...r.stats, equity: r.equity, trades: r.trades, choices: r.choices.map((c) => ({ ...c, tuned: c.picks.map((id) => (id >= 0 ? runs.find((x) => x.id === id)!.tuned : null)) })) };
    }
    process.stderr.write(`  ${v.name} done\n`);
    return { name: v.name, pool: v.pool, o: v.o, ...per };
  });
  const hold = Object.fromEntries(
    Object.entries(periods).map(([k, [s, e]]) => {
      const a = base[lowerBound(base, s)].open;
      const b = base[Math.min(base.length - 1, lowerBound(base, e) - 1)].close;
      return [k, ((b - a) / a) * 100];
    }),
  );
  writeFileSync(out, JSON.stringify({ periods, hold, results }));
}
