/**
 * Trend + volatility control on long CSVs of 1-minute candles, per market and as a portfolio.
 *   npx vite-node scripts/trend-research.ts -- <out.json> <SYMBOL=path.csv> ...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { DAY, DEFAULT_TREND, runTrendBacktest } from '../src/engine/trend';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const DEV: [number, number] = [utc('2025-05-10T00:00:00'), utc('2026-04-01T00:00:00')];
const VAL_START = utc('2026-04-01T00:00:00');
const COST_PCT = 0.12; // 0.1% fee + 0.02% slippage

function load(path: string): Candle[] {
  const out: Candle[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const p = line.split(',');
    if (p.length < 6 || !/^\d/.test(p[0])) continue;
    out.push({ time: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  return out;
}

const [out, ...pairs] = process.argv.slice(2).filter((a) => a !== '--');
const res: Record<string, unknown> = {};
for (const pair of pairs) {
  const [sym, path] = pair.split('=');
  const base = load(path);
  const end = Math.floor((base[base.length - 1].time + 60) / DAY) * DAY;
  const periods = { dev: DEV, val: [VAL_START, end - 20 * DAY] as [number, number], test: [end - 20 * DAY, end] as [number, number], all: [DEV[0], end] as [number, number] };
  const r: Record<string, Record<string, unknown>> = {};
  for (const [variant, longOnly] of [['longshort', false], ['longonly', true]] as const) {
    r[variant] = {};
    for (const [k, [s, e]] of Object.entries(periods)) {
      const bt = runTrendBacktest(base, s, e, 10_000, COST_PCT, { ...DEFAULT_TREND, longOnly });
      r[variant][k] = bt;
    }
    const line = (['dev', 'val', 'test', 'all'] as const)
      .map((k) => {
        const s = (r[variant][k] as ReturnType<typeof runTrendBacktest>).stats;
        return `${k}: ${s.returnPct.toFixed(1)}% dd ${s.maxDrawdownPct.toFixed(1)} n${s.rebalances} hold ${s.buyHoldPct.toFixed(1)}%`;
      })
      .join(' | ');
    console.log(`${sym} ${variant.padEnd(9)} ${line}`);
  }
  res[sym] = r;
}
writeFileSync(out, JSON.stringify(res));
