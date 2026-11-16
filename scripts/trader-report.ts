/**
 * Before and after, on 1-minute Binance BTC prices: the old modes against the new trader (4-hour
 * momentum signals, buys and shorts, each trade sized so its stop loses a set % of the account,
 * fees included). Older period Mar 2025 – Mar 2026, newer Apr – Oct 26 2026, and the hidden days
 * after that, which no research looked at. 15-day windows show what a 15-day run can bring.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/trader-report.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { LIVE_SETTINGS, SETTINGS, TRADER_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds } from '../src/engine/backtest';

const [outPath = 'trader-report.json'] = process.argv.slice(2).filter((a) => a !== '--');
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

const b4 = aggregate(base, tfSeconds('4h'));
const s4 = computeSignals('macd', b4, Math.max(0, lowerBound(b4, P.older[0]) - 1));
const s1 = computeSignals('chart', base, Math.max(0, lowerBound(base, P.older[0] - 86400) - 1));
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

const out: Record<string, unknown> = {};
function run(name: string, st: BotSettings, tf: '4h' | '1m') {
  const bars = tf === '4h' ? b4 : base;
  const signals = tf === '4h' ? s4 : s1;
  const line: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [k, [a, z]] of Object.entries(P)) {
    const r = runBacktest({ base, start: a, end: z, timeframe: tf, settings: st, startCash: 10_000, bars, signals, quiet: true });
    const s = r.stats;
    const w: number[] = [];
    for (let t = a; t + 15 * 86400 <= z; t += 15 * 86400) {
      w.push(runBacktest({ base, start: t, end: t + 15 * 86400, timeframe: tf, settings: st, startCash: 10_000, bars, signals, quiet: true }).stats.returnPct);
    }
    const ws = sorted(w);
    const worstTrade = Math.min(0, ...r.trades.map((t) => t.pnl));
    const fees = r.trades.reduce((sum, t) => sum + t.fees, 0);
    line[k] = {
      days: Math.round((z - a) / 86400),
      returnPct: +s.returnPct.toFixed(1),
      trades: s.trades,
      won: r.trades.filter((t) => t.pnl > 0).length,
      maxDrawdownPct: +s.maxDrawdownPct.toFixed(1),
      worstTrade: +worstTrade.toFixed(0),
      fees: +fees.toFixed(0),
      holdPct: +s.buyHoldPct.toFixed(1),
      fifteenDay: ws.length ? { windows: ws.length, median: +ws[ws.length >> 1].toFixed(1), worst: +ws[0].toFixed(1), best: +ws[ws.length - 1].toFixed(1), positivePct: Math.round((100 * ws.filter((x) => x > 0).length) / ws.length) } : null,
    };
    parts.push(
      `${k}: ${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}% (${s.trades} tr, dd ${s.maxDrawdownPct.toFixed(1)}%, worst trade $${worstTrade.toFixed(0)}, fees $${fees.toFixed(0)}, hold ${s.buyHoldPct.toFixed(1)}%)` +
        (ws.length ? ` 15d median ${ws[ws.length >> 1].toFixed(1)}% worst ${ws[0].toFixed(1)}% best ${ws[ws.length - 1].toFixed(1)}% positive ${Math.round((100 * ws.filter((x) => x > 0).length) / ws.length)}%` : ''),
    );
  }
  out[name] = line;
  console.log(`${name}\n   ${parts.join('\n   ')}`);
}

run('Before: Live 1-minute mode (whole account)', LIVE_SETTINGS, '1m');
run('Before: Tested 4-hour mode (whole account)', SETTINGS, '4h');
for (const riskPct of [0.5, 1, 2]) {
  run(`After: trader, most loss a trade ${riskPct}%`, { ...TRADER_SETTINGS, riskPct }, '4h');
}
run('After: trader 0.5%, buys only (real trading)', { ...TRADER_SETTINGS, allowShort: false }, '4h');
run('After: trader 0.5%, with the quiet-market filter', { ...TRADER_SETTINGS, feeFilter: true }, '4h');
writeFileSync(outPath, JSON.stringify(out, null, 2));
