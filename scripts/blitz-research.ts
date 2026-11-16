/**
 * Blitz mode research: quick trades on the 1-minute chart, in 2-hour sessions.
 *
 * Stage 1 (older period, all hours): every chart strategy with several quick exits, one trade at a
 * time, the whole account per trade, to see which comes closest to beating the fees: trades a day,
 * win rate, and the average result per trade before and after fees.
 * Stage 2 (newer period and hidden days): the best three on the older period, run as one 2-hour
 * session a day at four times of day, each trade sized to lose 0.25% of the account at its stop,
 * with a session stop at −2%.
 *
 *   DATA=BTCUSDT.csv HIDDEN_FROM=<unix seconds> npx vite-node scripts/blitz-research.ts -- [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotSettings, Candle, StrategyId } from '../src/types';
import { CLASSIC_SETTINGS } from '../src/store/useStore';
import { computeSignals, lowerBound, runBacktest, type SignalSeries } from '../src/engine/backtest';

const [outPath = 'blitz-research.json'] = process.argv.slice(2).filter((a) => a !== '--');
const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const OLDER: [number, number] = [utc('2025-03-01T00:00:00'), utc('2026-04-01T00:00:00')];
const LATER: Record<string, [number, number]> = { newer: [utc('2026-04-01T00:00:00'), utc('2026-10-27T00:00:00')] };
if (process.env.HIDDEN_FROM) LATER.hidden = [Number(process.env.HIDDEN_FROM), base[base.length - 1].time + 60];

const QUICK: BotSettings = {
  ...CLASSIC_SETTINGS,
  tradeAmount: 10_000,
  budget: 10_000,
  maxLoss: 0,
  minConfidence: 50,
  allowShort: true,
  trailingStop: false,
  trendFilter: false,
  feeFilter: false,
  cooldownSec: 60,
  maxTradesPerMinute: 1,
  entryTiming: 'close',
};
const EXITS: Record<string, Partial<BotSettings>> = {
  'stop 0.3% / target 0.45%, 30 min': { stopMode: 'percent', stopLossPct: 0.3, takeProfitPct: 0.45, maxHoldMin: 30, exitOnSignal: false },
  'stop 0.5% / target 0.75%, 60 min': { stopMode: 'percent', stopLossPct: 0.5, takeProfitPct: 0.75, maxHoldMin: 60, exitOnSignal: false },
  'stop 1.5 ATR / target 2 ATR, 30 min': { stopMode: 'atr', stopAtr: 1.5, targetAtr: 2, maxHoldMin: 30, exitOnSignal: false },
  'stop 0.5%, sell when the chart turns, 60 min': { stopMode: 'percent', stopLossPct: 0.5, takeProfitPct: 0, maxHoldMin: 60, exitOnSignal: true },
};
const STRATS: StrategyId[] = ['macd', 'ema', 'rsi', 'bollinger', 'breakout', 'pullback', 'chart', 'smart'];

const from = Math.max(0, lowerBound(base, OLDER[0] - 400 * 60));
const signals: Partial<Record<StrategyId, SignalSeries>> = {};
for (const s of STRATS) {
  const t0 = Date.now();
  signals[s] = computeSignals(s, base, from);
  process.stderr.write(`${s}: signals in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

/* Stage 1 */
interface Row { name: string; st: BotSettings; perDay: number; win: number; gross: number; net: number }
const rows: Row[] = [];
const days = (OLDER[1] - OLDER[0]) / 86400;
for (const s of STRATS) {
  for (const [exitName, exit] of Object.entries(EXITS)) {
    const st: BotSettings = { ...QUICK, strategy: s, ...exit, liveExits: s === 'chart' && exit.exitOnSignal ? true : undefined };
    const r = runBacktest({ base, start: OLDER[0], end: OLDER[1], timeframe: '1m', settings: st, startCash: 10_000, bars: base, signals: signals[s], quiet: true });
    const n = r.trades.length || 1;
    // Per trade, in % of the amount traded: before fees (slippage included) and after.
    const gross = (r.trades.reduce((a, t) => a + (t.pnl + t.fees) / (t.qty * t.entryPrice), 0) / n) * 100;
    const net = (r.trades.reduce((a, t) => a + t.pnl / (t.qty * t.entryPrice), 0) / n) * 100;
    const row = { name: `${s} · ${exitName}`, st, perDay: r.trades.length / days, win: (100 * r.trades.filter((t) => t.pnl > 0).length) / n, gross, net };
    rows.push(row);
    console.log(`${row.name.padEnd(58)} ${row.perDay.toFixed(1).padStart(5)}/day  won ${row.win.toFixed(0).padStart(2)}%  before fees ${gross >= 0 ? '+' : ''}${gross.toFixed(3)}%  after ${net.toFixed(3)}% a trade`);
  }
}
rows.sort((a, b) => b.gross - a.gross);
const best = rows.slice(0, 3);
console.log(`\nBest on the older period (before fees): ${best.map((b) => b.name).join(' | ')}`);

/* Stage 2: one 2-hour session a day */
const out: Record<string, unknown> = { stage1: rows.map(({ st: _st, ...r }) => r) };
const sessions: Record<string, unknown> = {};
for (const b of best) {
  for (const startHour of [2, 8, 13, 20]) {
    for (const [k, [a, z]] of Object.entries(LATER)) {
      const st: BotSettings = { ...b.st, sizing: 'risk', riskPct: 0.25, tradeAmount: Number.MAX_SAFE_INTEGER, budget: Number.MAX_SAFE_INTEGER, maxLoss: 200 };
      const res: { ret: number; trades: number }[] = [];
      for (let d = Math.floor(a / 86400) * 86400; d + 86400 <= z; d += 86400) {
        const s0 = d + startHour * 3600;
        if (s0 < a) continue;
        const r = runBacktest({ base, start: s0, end: s0 + 7200, timeframe: '1m', settings: st, startCash: 10_000, bars: base, signals: signals[b.st.strategy], quiet: true });
        res.push({ ret: r.stats.returnPct, trades: r.stats.trades });
      }
      const rets = res.map((x) => x.ret).sort((x, y) => x - y);
      const line = {
        sessions: rets.length,
        avg: +(rets.reduce((x, y) => x + y, 0) / rets.length).toFixed(2),
        median: +rets[rets.length >> 1].toFixed(2),
        worst: +rets[0].toFixed(2),
        best: +rets[rets.length - 1].toFixed(2),
        up: Math.round((100 * rets.filter((x) => x > 0).length) / rets.length),
        tradesPerSession: +(res.reduce((x, y) => x + y.trades, 0) / res.length).toFixed(1),
      };
      sessions[`${b.name} · ${String(startHour).padStart(2, '0')}:00 UTC · ${k}`] = line;
      console.log(`${b.name} · ${String(startHour).padStart(2, '0')}:00–${String(startHour + 2).padStart(2, '0')}:00 UTC · ${k}: avg ${line.avg}% median ${line.median}% worst ${line.worst}% best ${line.best}% up ${line.up}% · ${line.tradesPerSession} trades a session`);
    }
  }
}
out.sessions = sessions;
writeFileSync(outPath, JSON.stringify(out, null, 2));
