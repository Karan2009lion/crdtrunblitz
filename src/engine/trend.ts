import type { Candle } from '../types';

/**
 * Trend following with volatility control.
 *
 * Once a day the bot checks whether price is higher or lower than it was 20, 60 and 120 days
 * ago and leans long or short by how many of those agree. It sizes the position so the
 * holding swings about `targetVolPct` a year: big in calm markets, small in wild ones. After a
 * sharp move against it the measured volatility rises and the position shrinks, and when a
 * trend breaks the signal flips. It only trades when the target size has moved meaningfully,
 * to keep fees down. The same rules are used for every market.
 */

export const DAY = 86_400;

export interface TrendOptions {
  lookbacks: number[];
  targetVolPct: number;
  volDays: number;
  /** Only rebalance when the target weight moves by more than this (0.1 = 10% of the market's capital). */
  band: number;
  longOnly: boolean;
}

export const DEFAULT_TREND: TrendOptions = { lookbacks: [20, 60, 120], targetVolPct: 25, volDays: 30, band: 0.1, longOnly: false };

export const trendWarmupDays = (o: TrendOptions = DEFAULT_TREND) => Math.max(...o.lookbacks, o.volDays) + 1;

export interface TrendTarget {
  /** -1 … 1: share of the market's capital to hold, negative for short. */
  weight: number;
  /** -1 … 1: how many look-backs point up minus down, averaged. */
  signal: number;
  /** Recent volatility, annualised percent. */
  volPct: number;
  reasons: string[];
  ready: boolean;
}

/** Daily closes (the last minute of each UTC day) from minute or hourly candles. */
export function dailyCloses(candles: Candle[]): { day: number; close: number }[] {
  const out: { day: number; close: number }[] = [];
  for (const c of candles) {
    const day = Math.floor(c.time / DAY) * DAY;
    if (out.length && out[out.length - 1].day === day) out[out.length - 1].close = c.close;
    else out.push({ day, close: c.close });
  }
  return out;
}

/** Target position from daily closes up to and including the latest finished day. */
export function trendTarget(closes: number[], o: TrendOptions = DEFAULT_TREND): TrendTarget {
  const need = trendWarmupDays(o);
  const i = closes.length - 1;
  if (closes.length < need) return { weight: 0, signal: 0, volPct: 0, reasons: [`Collecting daily history: ${closes.length}/${need} days`], ready: false };
  const votes = o.lookbacks.map((n) => (closes[i] > closes[i - n] ? 1 : -1));
  const signal = votes.reduce((a, b) => a + b, 0) / votes.length;
  const rets: number[] = [];
  for (let k = i - o.volDays + 1; k <= i; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(365);
  const scale = vol > 0 ? Math.min(1, o.targetVolPct / 100 / vol) : 0;
  let weight = signal * scale;
  if (o.longOnly) weight = Math.max(0, weight);
  const dirs = o.lookbacks.map((n, k) => `${n}d ${votes[k] > 0 ? 'up' : 'down'}`).join(', ');
  const reasons = [
    `Trend: ${dirs}`,
    `Volatility ${(vol * 100).toFixed(0)}% a year, so size is scaled to ${(scale * 100).toFixed(0)}%`,
    weight === 0 ? (o.longOnly && signal < 0 ? 'Downtrend and shorting is off: stay in cash' : 'No clear trend: stay in cash') : `Target: ${weight > 0 ? 'long' : 'short'} ${(Math.abs(weight) * 100).toFixed(0)}% of this market's capital`,
  ];
  return { weight, signal, volPct: vol * 100, reasons, ready: true };
}

export interface TrendRebalance {
  time: number;
  price: number;
  fromWeight: number;
  toWeight: number;
  /** Notional bought (+) or sold (−), in dollars. */
  traded: number;
  fee: number;
  reasons: string[];
}

export interface TrendBacktestResult {
  equity: { time: number; value: number }[];
  rebalances: TrendRebalance[];
  stats: { startCash: number; endEquity: number; returnPct: number; maxDrawdownPct: number; rebalances: number; fees: number; buyHoldPct: number; startPrice: number };
}

/**
 * Replays the trend rules on history. The position is rebalanced at each daily close and
 * marked to market every day in between; costs are fee + slippage on the notional traded.
 */
export function runTrendBacktest(
  base: Candle[],
  start: number,
  end: number,
  startCash: number,
  costPct: number,
  o: TrendOptions = DEFAULT_TREND,
): TrendBacktestResult {
  const days = dailyCloses(base.filter((c) => c.time < end));
  const cost = costPct / 100;
  let equity = startCash;
  let w = 0;
  let peak = startCash;
  let maxDd = 0;
  let fees = 0;
  const curve: { time: number; value: number }[] = [];
  const rebalances: TrendRebalance[] = [];
  const closes = days.map((d) => d.close);
  let firstClose: number | null = null;
  let lastClose = 0;

  for (let i = 1; i < days.length; i++) {
    const t = days[i].day;
    const r = closes[i] / closes[i - 1] - 1;
    if (days[i - 1].day >= start && t < end) {
      // Hold yesterday's weight through today; the weight then drifts with price.
      const next = equity * (1 + w * r);
      w = next > 0 ? (w * (1 + r) * equity) / next : 0;
      equity = next;
    }
    if (t < start || t >= end) continue;
    firstClose ??= closes[i - 1];
    lastClose = closes[i];
    const tgt = trendTarget(closes.slice(0, i + 1), o);
    if (tgt.ready && (Math.abs(tgt.weight - w) > o.band || (tgt.weight === 0 && w !== 0))) {
      const traded = (tgt.weight - w) * equity;
      const fee = Math.abs(traded) * cost;
      rebalances.push({ time: t + DAY, price: closes[i], fromWeight: w, toWeight: tgt.weight, traded, fee, reasons: tgt.reasons });
      equity -= fee;
      fees += fee;
      w = tgt.weight;
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
    curve.push({ time: t + DAY, value: equity });
  }
  return {
    equity: curve,
    rebalances,
    stats: {
      startCash,
      endEquity: equity,
      returnPct: ((equity - startCash) / startCash) * 100,
      maxDrawdownPct: maxDd,
      rebalances: rebalances.length,
      fees,
      buyHoldPct: firstClose ? ((lastClose - firstClose) / firstClose) * 100 : 0,
      startPrice: firstClose ?? 0,
    },
  };
}

/**
 * Runs trend mode and returns it in the backtest screen's result shape: price candles for the
 * chart, a buy or sell marker per rebalance, the account value and a log of each decision.
 */
export function trendAsBacktest(input: {
  base: Candle[];
  display: Candle[];
  start: number;
  end: number;
  startCash: number;
  costPct: number;
  options: TrendOptions;
}): import('./backtest').BacktestResult {
  const r = runTrendBacktest(input.base, input.start, input.end, input.startCash, input.costPct, input.options);
  const pct = (w: number) => `${w > 0 ? 'long ' : w < 0 ? 'short ' : ''}${Math.abs(w * 100).toFixed(0)}%`;
  const fills = r.rebalances.map((rb, i) => ({
    id: `rb${i}`,
    time: rb.time * 1000,
    symbol: 'BT',
    action: rb.traded > 0 ? ('buy' as const) : ('sell' as const),
    kind: rb.traded > 0 ? ('open' as const) : ('close' as const),
    qty: Math.abs(rb.traded) / rb.price,
    price: rb.price,
    by: 'bot' as const,
  }));
  const log = r.rebalances.map((rb) => ({
    time: rb.time * 1000,
    level: rb.traded > 0 ? ('buy' as const) : ('sell' as const),
    message: `Rebalanced from ${rb.fromWeight === 0 ? 'cash' : pct(rb.fromWeight)} to ${rb.toWeight === 0 ? 'cash' : pct(rb.toWeight)} at ${rb.price.toFixed(2)} (${rb.traded > 0 ? 'bought' : 'sold'} $${Math.abs(rb.traded).toFixed(0)}). ${rb.reasons.join('. ')}.`,
  }));
  const s = r.stats;
  return {
    bars: input.display.filter((b) => b.time >= input.start && b.time < input.end),
    rebalances: r.rebalances,
    trades: [],
    fills,
    equity: r.equity,
    log,
    stats: {
      startCash: s.startCash,
      endEquity: s.endEquity,
      netPnl: s.endEquity - s.startCash,
      returnPct: s.returnPct,
      buyHoldPct: s.buyHoldPct,
      startPrice: s.startPrice,
      trades: s.rebalances,
      wins: 0,
      winRate: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      best: 0,
      worst: 0,
      fees: s.fees,
      maxDrawdownPct: s.maxDrawdownPct,
      exposurePct: 0,
      longs: 0,
      shorts: 0,
    },
  };
}
