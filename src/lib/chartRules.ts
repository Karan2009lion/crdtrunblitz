import type { Candle } from '../types';
import { atr, ema, rsi } from './indicators';

/** One condition the bot reads off the chart. */
export interface ChartCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** What the chart says right now: buy when every entry check passes, sell when any exit check does. */
export interface ChartRead {
  ready: boolean;
  action: 'buy' | 'sell' | 'hold';
  /** All must be true to buy. */
  entry: ChartCheck[];
  /** Any one true means sell what is held. */
  exit: ChartCheck[];
  atrPct?: number;
}

export interface ChartRuleOptions {
  /** Smallest 1-minute ATR, in percent of price, worth trading: below it the move can't beat fees. */
  minMovePct: number;
  /** Most RSI can be when buying; above it the move is overheated. */
  maxRsi: number;
  /** Skip choppy markets: the share (0–1) of the last 30 minutes' movement that went one way. 0 = off. */
  minSteadiness: number;
  /** Also require the 4-hour trend to be up (price above its 4-hour average). */
  bigTrend: boolean;
  /** Sell on the 1-hour average only once price is this many typical minutes (ATR) below it. 0 = any dip. */
  exitBufferAtr: number;
  /** Also sell when the 9-minute average crosses under the 21-minute average. */
  trendExit: boolean;
}

/**
 * Below a 0.1% typical minute fees ate every setting faster (scripts/live-mode-research.ts). Skipping
 * choppy markets, buying only with the 4-hour trend, and selling only clearly below the 1-hour
 * average cut the typical real 10-day loss from 6.6% to 2.5% (scripts/loss-research.ts).
 */
export const CHART_RULES: ChartRuleOptions = { minMovePct: 0.1, maxRsi: 70, minSteadiness: 0.3, bigTrend: true, exitBufferAtr: 1, trendExit: false };

/** Candles needed before the 1-hour average is meaningful. */
export const CHART_MIN_BARS = 70;
/** Candles needed for the 4-hour average. */
const BIG_TREND_BARS = 240;

const pctText = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

/**
 * Reads 1-minute candles the way a trader scans a chart: is the short-term trend up, is price above
 * its 1-hour average, is it still climbing, is it not overheated, and is it moving enough to cover
 * fees. The last candle may still be forming, so a live price can trigger a sell straight away.
 */
export function readChart(candles: Candle[], opts: ChartRuleOptions = CHART_RULES): ChartRead {
  if (candles.length < (opts.bigTrend ? BIG_TREND_BARS + 1 : CHART_MIN_BARS)) {
    return { ready: false, action: 'hold', entry: [], exit: [] };
  }
  const window = candles.slice(-300);
  const closes = window.map((c) => c.close);
  const n = closes.length - 1;
  const price = closes[n];
  const e9 = ema(closes, 9)[n];
  const e21 = ema(closes, 21)[n];
  const e60 = ema(closes, 60)[n];
  const r = rsi(closes, 14)[n];
  const a = atr(window, 14)[n];
  const atrPct = price > 0 && Number.isFinite(a) ? (a / price) * 100 : undefined;
  const change5 = ((price - closes[n - 5]) / closes[n - 5]) * 100;
  // Steadiness (efficiency ratio): net move over the path travelled, last 30 minutes.
  let path = 0;
  for (let i = n - 29; i <= n; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const steadiness = path > 0 ? Math.abs(price - closes[n - 30]) / path : 0;

  const trendUp = e9 > e21;
  const aboveHour = price > e60;
  const entry: ChartCheck[] = [
    { label: 'Short-term trend up', ok: trendUp, detail: trendUp ? '9-minute average is above the 21-minute average' : '9-minute average is below the 21-minute average' },
    { label: 'Above the 1-hour average', ok: aboveHour, detail: `Price is ${pctText(((price - e60) / e60) * 100)} from its 1-hour average` },
    { label: 'Still climbing', ok: change5 > 0, detail: `${pctText(change5)} over the last 5 minutes` },
    { label: 'Not overheated', ok: Number.isFinite(r) && r < opts.maxRsi, detail: `RSI ${Number.isFinite(r) ? r.toFixed(0) : '–'} (above ${opts.maxRsi} is overheated)` },
    {
      label: 'Moving enough to beat fees',
      ok: atrPct !== undefined && atrPct >= opts.minMovePct,
      detail: `A typical minute moves ${atrPct === undefined ? '–' : atrPct.toFixed(3)}%; needs ${opts.minMovePct}%`,
    },
  ];
  if (opts.minSteadiness > 0) {
    entry.push({
      label: 'Steady, not choppy',
      ok: steadiness >= opts.minSteadiness && price > closes[n - 30],
      detail: `${Math.round(steadiness * 100)}% of the last 30 minutes' movement went one way; needs ${Math.round(opts.minSteadiness * 100)}% upward`,
    });
  }
  if (opts.bigTrend) {
    let sum = 0;
    for (let i = n - BIG_TREND_BARS + 1; i <= n; i++) sum += closes[i];
    const avg4h = sum / BIG_TREND_BARS;
    entry.push({ label: '4-hour trend up', ok: price > avg4h, detail: `Price is ${pctText(((price - avg4h) / avg4h) * 100)} from its 4-hour average` });
  }
  const floor = e60 - opts.exitBufferAtr * (Number.isFinite(a) ? a : 0);
  const exit: ChartCheck[] = [
    ...(opts.trendExit ? [{ label: 'Short-term trend turned down', ok: !trendUp, detail: entry[0].detail }] : []),
    {
      label: opts.exitBufferAtr > 0 ? 'Fell clearly below the 1-hour average' : 'Fell below the 1-hour average',
      ok: price < floor,
      detail: opts.exitBufferAtr > 0 ? `Sells under ${floor.toFixed(2)}, ${opts.exitBufferAtr}× a typical minute below the 1-hour average` : entry[1].detail,
    },
  ];
  const action = exit.some((c) => c.ok) ? 'sell' : entry.every((c) => c.ok) ? 'buy' : 'hold';
  return { ready: true, action, entry, exit, atrPct };
}
