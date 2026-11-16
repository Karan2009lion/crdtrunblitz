/**
 * Which changes cut Live mode's losses? Tries every mix of four fixes on the chart reader:
 *   - skip choppy markets (steadiness of the last 30 minutes),
 *   - only buy when the 4-hour trend is also up,
 *   - sell on the 1-hour average only once price is clearly below it (a 1-ATR buffer),
 *   - drop the sell on the 9/21-minute cross,
 * with a 1.5 or 2.5 ATR stop. Each is run as 10-day paper tests on real 1-minute BTC prices
 * (chosen on the older year, checked on the newer months) and on the 20 made-up scenario runs.
 *
 *   DATA=BTCUSDT.csv npx vite-node scripts/loss-research.ts
 */
import { readFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { LIVE_SETTINGS } from '../src/store/useStore';
import { lowerBound, runBacktest, type SignalSeries } from '../src/engine/backtest';
import { CHART_RULES, readChart, type ChartRuleOptions } from '../src/lib/chartRules';
import { WARMUP, makePrices } from './lib/scenarios';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const DEV: [number, number] = [utc('2025-03-01T00:00:00'), utc('2026-04-01T00:00:00')];
const VAL: [number, number] = [DEV[1], utc('2026-10-27T02:28:00')];
const real: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const seeds = Array.from({ length: 20 }, (_, k) => makePrices(k + 1).map(({ scenario: _s, ...c }) => c as Candle));

function series(base: Candle[], from: number, opts: ChartRuleOptions): SignalSeries {
  const n = base.length;
  const score = new Int16Array(n);
  const ready = new Uint8Array(n);
  const atrPct = new Float64Array(n).fill(NaN);
  for (let i = from; i < n; i++) {
    const r = readChart(base.slice(Math.max(0, i - 299), i + 1), opts);
    score[i] = r.action === 'buy' ? 100 : r.action === 'sell' ? -100 : 0;
    ready[i] = r.ready ? 1 : 0;
    atrPct[i] = r.atrPct ?? NaN;
  }
  return { score, ready, atrPct, trend: new Int8Array(n), verdicts: true };
}

const windows = ([a, z]: [number, number]) => {
  const out: number[] = [];
  for (let d = a; d + 10 * 86400 <= z; d += 10 * 86400) out.push(d);
  return out;
};
const devWins = windows(DEV);
const valWins = windows(VAL);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

interface Row {
  name: string;
  opts: ChartRuleOptions;
  stopAtr: number;
  dev: { med: number; worst: number; tpd: number; gross: number };
  val: { med: number; worst: number; tpd: number; gross: number };
  syn: { mean: number; ahead: number; gross: number; trades: number };
}
const rows: Row[] = [];
const realFrom = Math.max(0, lowerBound(real, DEV[0]) - 300);
for (const minSteadiness of [0, 0.3, 0.5])
  for (const bigTrend of [false, true])
    for (const exitBufferAtr of [0, 1])
      for (const trendExit of [true, false]) {
        const opts: ChartRuleOptions = { ...CHART_RULES, minSteadiness, bigTrend, exitBufferAtr, trendExit };
        const t0 = Date.now();
        const sig = series(real, realFrom, opts);
        const synSig = seeds.map((b) => series(b, 0, opts));
        for (const stopAtr of [1.5, 2.5]) {
          const st: BotSettings = { ...LIVE_SETTINGS, stopAtr };
          const tenDay = (wins: number[]) => {
            const net: number[] = [];
            const gross: number[] = [];
            const tpd: number[] = [];
            for (const s0 of wins) {
              const r = runBacktest({ base: real, start: s0, end: s0 + 10 * 86400, timeframe: '1m', settings: st, startCash: 10_000, bars: real, signals: sig, quiet: true }).stats;
              const g = runBacktest({ base: real, start: s0, end: s0 + 10 * 86400, timeframe: '1m', settings: { ...st, feePct: 0, slippagePct: 0 }, startCash: 10_000, bars: real, signals: sig, quiet: true }).stats;
              net.push(r.returnPct);
              gross.push(g.returnPct);
              tpd.push(r.trades / 10);
            }
            return { med: median(net), worst: Math.min(...net), tpd: median(tpd), gross: median(gross) };
          };
          const syn = seeds.map((b, k) => {
            const run = (fees: boolean) =>
              runBacktest({ base: b, start: b[WARMUP].time, timeframe: '1m', settings: fees ? st : { ...st, feePct: 0, slippagePct: 0 }, startCash: 10_000, bars: b, signals: synSig[k], quiet: true }).stats;
            const r = run(true);
            return { net: r.returnPct, gross: run(false).returnPct, trades: r.trades };
          });
          const parts = [
            minSteadiness ? `steady ≥${minSteadiness * 100}%` : '',
            bigTrend ? '4h trend up' : '',
            exitBufferAtr ? 'exit buffer 1 ATR' : '',
            trendExit ? '' : 'no 9/21 exit',
            `stop ${stopAtr} ATR`,
          ].filter(Boolean);
          rows.push({
            name: parts.join(', '),
            opts,
            stopAtr,
            dev: tenDay(devWins),
            val: tenDay(valWins),
            syn: { mean: mean(syn.map((s) => s.net)), ahead: syn.filter((s) => s.net > 0).length, gross: mean(syn.map((s) => s.gross)), trades: mean(syn.map((s) => s.trades)) },
          });
        }
        process.stderr.write(`${rows.length}/48 done (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
      }

const f = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const line = (r: Row) =>
  `${r.name.padEnd(62)} real 10-day: older ${f(r.dev.med)} (worst ${f(r.dev.worst)}, ${r.dev.tpd.toFixed(1)}/day, no fees ${f(r.dev.gross)}) | newer ${f(r.val.med)} (worst ${f(r.val.worst)}, no fees ${f(r.val.gross)}) | made-up: ${f(r.syn.mean)}, ahead ${r.syn.ahead}/20, ${r.syn.trades.toFixed(0)} trades, no fees ${f(r.syn.gross)}`;
const current = rows.find((r) => !r.opts.minSteadiness && !r.opts.bigTrend && !r.opts.exitBufferAtr && r.opts.trendExit && r.stopAtr === 1.5)!;
console.log('Current Live mode:\n  ' + line(current));
rows.sort((a, b) => b.dev.med - a.dev.med);
console.log('\nAll 48, best first by the older year of real prices:');
for (const r of rows) console.log('  ' + line(r));
