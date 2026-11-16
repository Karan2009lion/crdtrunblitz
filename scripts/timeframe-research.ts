/**
 * How often should the bot think about buying? The trader's momentum rules on 1-minute,
 * 15-minute, 1-hour and 4-hour candles, each trade sized so its stop loses 0.5% of the account.
 * Short candles move less than the fees, so each is also tried with a floor on the stop distance
 * (the target widens with it). Floors are compared on the older period; the newer period and the
 * hidden days are the check.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/timeframe-research.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle } from '../src/types';
import { TRADER_SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestTimeframe } from '../src/engine/backtest';

const [outPath = 'timeframe-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
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

/** 15-day windows read off one run's account curve. */
function windows(equity: { time: number; value: number }[], [a, z]: [number, number]) {
  const at = (t: number) => {
    let lo = 0;
    let hi = equity.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (equity[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return equity[lo].value;
  };
  const out: number[] = [];
  for (let t = a; t + 15 * 86400 <= z; t += 15 * 86400) out.push((at(t + 15 * 86400) / at(t) - 1) * 100);
  return out.sort((x, y) => x - y);
}

const out: Record<string, unknown> = {};
for (const tf of ['4h', '1h', '15m', '1m'] as BacktestTimeframe[]) {
  const t0 = Date.now();
  const sec = tfSeconds(tf);
  const bars = sec === 60 ? base : aggregate(base, sec);
  const from = Math.max(0, lowerBound(bars, P.older[0] - 400 * sec));
  const signals = computeSignals('macd', bars, from);
  process.stderr.write(`${tf}: signals in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  for (const minStopPct of [0, 1, 2, 3]) {
    const st: BotSettings = { ...TRADER_SETTINGS, minStopPct };
    const line: Record<string, unknown> = {};
    const parts: string[] = [];
    for (const [k, p] of Object.entries(P)) {
      const r = runBacktest({ base, start: p[0], end: p[1], timeframe: tf, settings: st, startCash: 10_000, bars, signals, quiet: true });
      const s = r.stats;
      const w = windows(r.equity, p);
      const days = (p[1] - p[0]) / 86400;
      line[k] = {
        returnPct: +s.returnPct.toFixed(1),
        trades: s.trades,
        perDay: +(s.trades / days).toFixed(2),
        winRate: +s.winRate.toFixed(0),
        maxDrawdownPct: +s.maxDrawdownPct.toFixed(1),
        worstTrade: +s.worst.toFixed(0),
        fees: +s.fees.toFixed(0),
        fifteenDay: w.length ? { median: +w[w.length >> 1].toFixed(1), worst: +w[0].toFixed(1), best: +w[w.length - 1].toFixed(1), positivePct: Math.round((100 * w.filter((x) => x > 0).length) / w.length) } : null,
      };
      parts.push(
        `${k}: ${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}% (${s.trades} tr, ${(s.trades / days).toFixed(2)}/day, won ${s.winRate.toFixed(0)}%, dd ${s.maxDrawdownPct.toFixed(1)}%, fees $${s.fees.toFixed(0)})` +
          (w.length > 1 ? ` 15d median ${w[w.length >> 1].toFixed(1)}% worst ${w[0].toFixed(1)}% up ${Math.round((100 * w.filter((x) => x > 0).length) / w.length)}%` : ''),
      );
    }
    out[`${tf} min stop ${minStopPct}%`] = line;
    console.log(`${tf}, stop at least ${minStopPct}%\n   ${parts.join('\n   ')}`);
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2));
}
