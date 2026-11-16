/**
 * The plan "5 hours a day, up to 2 trades an hour, each held up to 15 minutes", tested on BTC
 * 1-minute prices for an Indian trader with ₹1,00,000:
 *   - buy-then-sell only (Indian spot exchanges can't short),
 *   - fees with 18% GST, under several exchange fee levels,
 *   - 30% tax + 4% cess on every winning trade with no loss set-off, 1% TDS held on every sale.
 * Settings are chosen on the development period only, then checked on validation and test.
 *
 *   DATA=BTCUSDT.csv npx vite-node scripts/india-15m-research.ts -- out.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle, StrategyId } from '../src/types';
import { SETTINGS } from '../src/store/useStore';
import { aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestTimeframe } from '../src/engine/backtest';

const utc = (s: string) => Date.parse(s + 'Z') / 1000;
const PERIODS = {
  devA: [utc('2025-03-01T00:00:00'), utc('2025-09-15T00:00:00')],
  devB: [utc('2025-09-15T00:00:00'), utc('2026-04-01T00:00:00')],
  val: [utc('2026-04-01T00:00:00'), utc('2026-10-07T00:00:00')],
  test: [utc('2026-10-07T00:00:00'), utc('2026-10-27T02:28:00')],
} as const;
type PeriodName = keyof typeof PERIODS;

const CAPITAL = 100_000; // ₹
const TAX = 0.312; // 30% + 4% cess, on each winning trade
const TDS = 0.01; // held on each sale, returned only against the yearly tax bill
const HOLD_MIN = 15;
const PER_HOUR = 2;

/** Cost per side: exchange fee + 18% GST on it + slippage. */
const SCENARIOS = [
  { name: 'Zero-fee offer (e.g. WazirX ₹99/month plan)', fee: 0, slip: 0.0005 },
  { name: 'Binance, fees paid in BNB (0.075%)', fee: 0.00075, slip: 0.0002 },
  { name: 'Binance, normal (0.1%)', fee: 0.001, slip: 0.0002 },
  { name: 'Indian INR exchange (0.2%)', fee: 0.002, slip: 0.0005 },
].map((s) => ({ ...s, perSide: s.fee * 1.18 + s.slip }));

/** 5-hour daily windows, as UTC start hour (IST = UTC + 5:30). */
const WINDOWS = [
  { name: '08:00–13:00 IST', startMin: 2 * 60 + 30 },
  { name: '13:00–18:00 IST', startMin: 7 * 60 + 30 },
  { name: '19:00–00:00 IST (US open)', startMin: 13 * 60 + 30 },
  { name: '00:00–05:00 IST', startMin: 18 * 60 + 30 },
];

const base: Candle[] = readFileSync(process.env.DATA!, 'utf8')
  .split('\n')
  .slice(1)
  .filter(Boolean)
  .map((l) => {
    const [time, open, high, low, close, volume] = l.split(',').map(Number);
    return { time, open, high, low, close, volume };
  });
process.stderr.write(`loaded ${base.length} minutes\n`);

interface RawTrade {
  t: number;
  r: number; // gross return, exit / entry − 1
}
interface Config {
  strategy: StrategyId | 'every-30-min';
  tf: BacktestTimeframe;
  minConf: number;
  stop: number;
  target: number; // 0 = exit on time only
  window: number;
}

/** Simulates one config over all windows and periods; returns raw trades (costs applied later). */
function simulate(c: Config, score: (minuteEnd: number) => number | undefined): RawTrade[] {
  const out: RawTrade[] = [];
  const win = WINDOWS[c.window];
  const from = lowerBound(base, PERIODS.devA[0]);
  let pos: { entry: number; t: number; stop: number; target: number } | null = null;
  let hourKey = -1;
  let inHour = 0;
  for (let i = from; i < base.length; i++) {
    const m = base[i];
    const minOfDay = Math.floor((m.time % 86400) / 60);
    const rel = (minOfDay - win.startMin + 1440) % 1440;
    const inWindow = rel < 300;
    if (pos) {
      const held = (m.time - pos.t) / 60 + 1;
      let exit: number | null = null;
      if (m.low <= pos.stop) exit = Math.min(m.open, pos.stop);
      else if (pos.target && m.high >= pos.target) exit = Math.max(m.open, pos.target);
      else if (held >= HOLD_MIN || !inWindow || rel === 299) exit = m.close;
      if (exit !== null) {
        out.push({ t: m.time, r: exit / pos.entry - 1 });
        pos = null;
      }
      continue;
    }
    if (!inWindow || rel >= 299 - HOLD_MIN) continue;
    const hk = Math.floor(m.time / 3600);
    if (hk !== hourKey) {
      hourKey = hk;
      inHour = 0;
    }
    if (inHour >= PER_HOUR) continue;
    const s = score(m.time + 60);
    if (s === undefined || s < c.minConf) continue;
    const entry = m.close;
    pos = { entry, t: m.time + 60, stop: entry * (1 - c.stop), target: c.target ? entry * (1 + c.target) : 0 };
    inHour++;
  }
  return out;
}

/** Applies costs, tax and TDS to raw trades inside a period. Results in ₹. */
function account(trades: RawTrade[], [a, z]: readonly [number, number], perSide: number) {
  let cash = CAPITAL;
  let tdsHeld = 0;
  let tax = 0;
  let fees = 0;
  let wins = 0;
  let n = 0;
  for (const tr of trades) {
    if (tr.t < a || tr.t >= z) continue;
    const size = cash; // TDS already held can't be traded
    if (size <= 0) break;
    const proceeds = size * (1 - perSide) * (1 + tr.r) * (1 - perSide);
    const pnl = proceeds - size;
    fees += size * perSide + size * (1 + tr.r) * perSide;
    const tds = proceeds * TDS;
    tdsHeld += tds;
    cash += pnl - tds;
    if (pnl > 0) {
      tax += pnl * TAX;
      wins++;
    }
    n++;
  }
  const preTax = cash + tdsHeld - CAPITAL;
  const months = (z - a) / (30 * 86400);
  return {
    trades: n,
    win: n ? Math.round((wins / n) * 100) : 0,
    preTax: Math.round(preTax),
    tax: Math.round(tax),
    afterTax: Math.round(preTax - tax),
    perMonthAfterTax: Math.round((preTax - tax) / months),
    tdsHeld: Math.round(tdsHeld),
    cashLeftToTrade: Math.round(cash),
    fees: Math.round(fees),
  };
}

// Signals for every strategy and candle size.
const TFS: BacktestTimeframe[] = ['1m', '5m', '15m'];
const STRATS: StrategyId[] = ['smart', 'ema', 'rsi', 'bollinger', 'macd', 'breakout', 'pullback'];
const configs: { c: Config; trades: RawTrade[] }[] = [];
for (const tf of TFS) {
  const sec = tfSeconds(tf);
  const bars = aggregate(base, sec);
  const from = Math.max(0, lowerBound(bars, PERIODS.devA[0]) - 1);
  for (const strategy of STRATS) {
    const t0 = Date.now();
    const sig = computeSignals(strategy, bars, from);
    process.stderr.write(`signals ${strategy}:${tf} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    const score = (minuteEnd: number) => {
      if (minuteEnd % sec) return undefined;
      const i = lowerBound(bars, minuteEnd - sec);
      return i < bars.length && bars[i].time === minuteEnd - sec && sig.ready[i] ? sig.score[i] : undefined;
    };
    for (const minConf of [50, 70])
      for (const stop of [0.0025, 0.005, 0.01])
        for (const target of [0.0025, 0.005, 0.01, 0])
          for (let window = 0; window < WINDOWS.length; window++) {
            const c = { strategy, tf, minConf, stop, target, window };
            configs.push({ c, trades: simulate(c, score) });
          }
  }
}
// Zero-skill baseline: buy every 30 minutes in the window, hold 15 minutes.
for (let window = 0; window < WINDOWS.length; window++) {
  const c: Config = { strategy: 'every-30-min', tf: '1m', minConf: 0, stop: 1, target: 0, window };
  configs.push({ c, trades: simulate(c, (t) => (t % 1800 === 0 ? 100 : undefined)) });
}
process.stderr.write(`${configs.length} configs simulated\n`);

const describe = (c: Config) =>
  c.strategy === 'every-30-min'
    ? `No signal: buy every 30 min, ${WINDOWS[c.window].name}`
    : `${c.strategy} ${c.tf} ≥${c.minConf}, stop ${c.stop * 100}%, target ${c.target ? c.target * 100 + '%' : 'none (15 min)'}, ${WINDOWS[c.window].name}`;

const report: Record<string, unknown> = {};
for (const sc of SCENARIOS) {
  const rows = configs.map(({ c, trades }) => {
    const r = {} as Record<PeriodName, ReturnType<typeof account>>;
    for (const p of Object.keys(PERIODS) as PeriodName[]) r[p] = account(trades, PERIODS[p], sc.perSide);
    return { name: describe(c), c, ...r };
  });
  // Choose on development only: both halves must make money after tax; rank by the weaker half.
  const chosen = rows
    .filter((r) => r.devA.afterTax > 0 && r.devB.afterTax > 0 && r.c.strategy !== 'every-30-min')
    .sort((x, y) => Math.min(y.devA.afterTax, y.devB.afterTax) - Math.min(x.devA.afterTax, x.devB.afterTax));
  const byDev = [...rows].sort((x, y) => y.devA.afterTax + y.devB.afterTax - (x.devA.afterTax + x.devB.afterTax));
  const baseline = rows.filter((r) => r.c.strategy === 'every-30-min');
  const medianVal = [...rows].map((r) => r.val.perMonthAfterTax).sort((x, y) => x - y)[Math.floor(rows.length / 2)];
  const profitableBothDev = chosen.length;
  const profitableAll = rows.filter((r) => r.devA.afterTax > 0 && r.devB.afterTax > 0 && r.val.afterTax > 0).length;
  report[sc.name] = { perSideCostPct: +(sc.perSide * 100).toFixed(4), configs: rows.length, profitableBothDev, profitableAll, medianValPerMonth: medianVal, chosen: chosen.slice(0, 5), bestDev: byDev.slice(0, 3), baseline };
  process.stderr.write(
    `\n== ${sc.name} (cost ${(sc.perSide * 200).toFixed(3)}% per round trip) ==\n` +
      `configs ${rows.length}; after-tax profit in both dev halves: ${profitableBothDev}; and in validation too: ${profitableAll}; median validation ₹/month ${medianVal}\n`,
  );
  for (const r of baseline.slice(0, 4))
    process.stderr.write(`  baseline ${r.name}: val ${r.val.trades} tr, ₹${r.val.perMonthAfterTax}/month after tax, TDS held ₹${r.val.tdsHeld}, cash left ₹${r.val.cashLeftToTrade}\n`);
  for (const r of chosen.slice(0, 3))
    process.stderr.write(
      `  chosen ${r.name}\n     dev ₹${r.devA.afterTax}+₹${r.devB.afterTax} after tax | val ${r.val.trades} tr ₹${r.val.preTax} pre-tax, tax ₹${r.val.tax}, ₹${r.val.perMonthAfterTax}/month | test ₹${r.test.afterTax}\n`,
    );
  if (!chosen.length) {
    const r = byDev[0];
    process.stderr.write(`  best on dev ${r.name}: dev ₹${r.devA.afterTax}+₹${r.devB.afterTax} | val ₹${r.val.perMonthAfterTax}/month after tax | test ₹${r.test.afterTax}\n`);
  }
}

// The 4-hour bot under Indian rules, with and without short selling.
const bars4h = aggregate(base, tfSeconds('4h'));
const sig4h = computeSignals(SETTINGS.strategy, bars4h, Math.max(0, lowerBound(bars4h, PERIODS.devA[0]) - 1));
for (const allowShort of [true, false]) {
  for (const sc of SCENARIOS.slice(1, 3)) {
    const settings = { ...SETTINGS, allowShort, feePct: 0, slippagePct: 0 };
    const line: string[] = [];
    for (const p of ['devA', 'devB', 'val', 'test'] as PeriodName[]) {
      const [a, z] = PERIODS[p];
      const r = runBacktest({ base, start: a, end: z, timeframe: '4h', settings, startCash: 10_000, bars: bars4h, signals: sig4h, quiet: true });
      const raw = r.trades.map((t) => ({ t: t.exitTime / 1000, r: (t.side === 'long' ? 1 : -1) * (t.exitPrice / t.entryPrice - 1) }));
      const acc = account(raw, [a, z], sc.perSide);
      line.push(`${p} ${acc.trades} tr ₹${acc.afterTax} after tax (pre-tax ₹${acc.preTax})`);
      (report[`4h bot ${allowShort ? 'with' : 'without'} shorts, ${sc.name}`] ??= {} as Record<string, unknown>) as Record<string, unknown>;
      (report[`4h bot ${allowShort ? 'with' : 'without'} shorts, ${sc.name}`] as Record<string, unknown>)[p] = acc;
    }
    process.stderr.write(`\n4h bot ${allowShort ? 'WITH' : 'WITHOUT'} shorts, ${sc.name}: ${line.join(' | ')}\n`);
  }
}
writeFileSync(process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'india-15m.json', JSON.stringify(report, null, 2));
