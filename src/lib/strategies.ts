import type { Candle, Signal, StrategyId } from '../types';
import { atr, bollinger, ema, last, macd, prev, rsi, sma } from './indicators';
import { CHART_MIN_BARS, readChart } from './chartRules';

export interface StrategyInfo {
  id: StrategyId;
  name: string;
  description: string;
  minBars: number;
}

export const STRATEGIES: StrategyInfo[] = [
  {
    id: 'smart',
    name: 'Smart blend',
    description: 'Weighs trend, momentum, RSI, Bollinger Bands and volume together. Trades only when several agree.',
    minBars: 52,
  },
  {
    id: 'ema',
    name: 'Trend follower',
    description: 'Buys when the 9 EMA crosses above the 21 EMA and sells on the opposite cross.',
    minBars: 23,
  },
  {
    id: 'rsi',
    name: 'Dip buyer (RSI)',
    description: 'Buys when RSI turns up from oversold (below 30) and sells when it turns down from overbought (above 70).',
    minBars: 17,
  },
  {
    id: 'bollinger',
    name: 'Band bounce',
    description: 'Buys when price closes back inside the lower Bollinger Band and sells back inside the upper band.',
    minBars: 22,
  },
  {
    id: 'macd',
    name: 'Momentum (MACD)',
    description: 'Follows momentum shifts when the MACD histogram flips from negative to positive or back.',
    minBars: 36,
  },
  {
    id: 'breakout',
    name: 'Breakout',
    description: 'Buys when price closes above its 20-candle high and sells below its 20-candle low. Stronger with high volume.',
    minBars: 22,
  },
  {
    id: 'chart',
    name: 'Chart reader',
    description: 'Buys when every check on the 1-minute chart passes (trend up, above the 1-hour average, still climbing, not overheated, moving enough to beat fees) and sells as soon as the trend turns.',
    minBars: CHART_MIN_BARS,
  },
  {
    id: 'pullback',
    name: 'Trend pullback',
    description: 'In an uptrend, buys when RSI dips under 40 and turns back up. In a downtrend, sells when RSI pops over 60 and turns down.',
    minBars: 202,
  },
];

export function strategyInfo(id: StrategyId): StrategyInfo {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const f1 = (n: number) => n.toFixed(1);

function notReady(info: StrategyInfo, have: number): Signal {
  return { score: 0, ready: false, reasons: [`Collecting data: ${have}/${info.minBars} candles`] };
}

function emaCross(candles: Candle[]): Signal {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const a = last(fast) - last(slow);
  const b = prev(fast) - prev(slow);
  const a14 = last(atr(candles, 14)) || Math.abs(last(closes)) * 0.001;
  if (b <= 0 && a > 0) return { score: 80, ready: true, reasons: ['9 EMA crossed above 21 EMA'] };
  if (b >= 0 && a < 0) return { score: -80, ready: true, reasons: ['9 EMA crossed below 21 EMA'] };
  const strength = clamp((a / a14) * 25, -45, 45);
  return {
    score: strength,
    ready: true,
    reasons: [a > 0 ? '9 EMA is above 21 EMA (uptrend)' : '9 EMA is below 21 EMA (downtrend)'],
  };
}

function rsiReversion(candles: Candle[]): Signal {
  const r = rsi(candles.map((c) => c.close), 14);
  const now = last(r);
  const before = prev(r);
  if (before < 30 && now >= before) return { score: clamp(60 + (30 - before) * 2, 60, 100), ready: true, reasons: [`RSI turned up from oversold (${f1(before)} → ${f1(now)})`] };
  if (before > 70 && now <= before) return { score: -clamp(60 + (before - 70) * 2, 60, 100), ready: true, reasons: [`RSI turned down from overbought (${f1(before)} → ${f1(now)})`] };
  return { score: clamp((50 - now) * 1.2, -50, 50), ready: true, reasons: [`RSI ${f1(now)} — waiting for an extreme`] };
}

function bandBounce(candles: Candle[]): Signal {
  const closes = candles.map((c) => c.close);
  const bb = bollinger(closes, 20, 2);
  const c0 = last(closes);
  const c1 = prev(closes);
  if (c1 < prev(bb.lower) && c0 > last(bb.lower)) return { score: 80, ready: true, reasons: ['Price closed back inside the lower Bollinger Band'] };
  if (c1 > prev(bb.upper) && c0 < last(bb.upper)) return { score: -80, ready: true, reasons: ['Price closed back inside the upper Bollinger Band'] };
  const width = last(bb.upper) - last(bb.lower) || 1;
  const pos = (c0 - last(bb.mid)) / (width / 2); // -1 at lower band, +1 at upper
  return { score: clamp(-pos * 40, -50, 50), ready: true, reasons: [`Price is ${pos >= 0 ? 'in the upper' : 'in the lower'} half of the bands`] };
}

function macdMomentum(candles: Candle[]): Signal {
  const m = macd(candles.map((c) => c.close));
  const h0 = last(m.hist);
  const h1 = prev(m.hist);
  const a14 = last(atr(candles, 14)) || 1;
  if (h1 <= 0 && h0 > 0) return { score: 75, ready: true, reasons: ['MACD histogram turned positive'] };
  if (h1 >= 0 && h0 < 0) return { score: -75, ready: true, reasons: ['MACD histogram turned negative'] };
  return {
    score: clamp((h0 / a14) * 120, -50, 50),
    ready: true,
    reasons: [h0 > 0 ? `MACD momentum is positive${h0 > h1 ? ' and rising' : ' but fading'}` : `MACD momentum is negative${h0 < h1 ? ' and falling' : ' but easing'}`],
  };
}

/** The default blend: each component adds points, then a trend and volume filter scale the total. */
function smartBlend(candles: Candle[]): Signal {
  const closes = candles.map((c) => c.close);
  const price = last(closes);
  const parts: { pts: number; why: string }[] = [];

  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const trendLine = ema(closes, 50);
  const vol = last(atr(candles, 14)) || price * 0.001;

  const gap = last(fast) - last(slow);
  const prevGap = prev(fast) - prev(slow);
  if (prevGap <= 0 && gap > 0) parts.push({ pts: 30, why: '9 EMA crossed above 21 EMA' });
  else if (prevGap >= 0 && gap < 0) parts.push({ pts: -30, why: '9 EMA crossed below 21 EMA' });
  else {
    const pts = clamp((gap / vol) * 15, -20, 20);
    if (Math.abs(pts) >= 5) parts.push({ pts, why: gap > 0 ? 'Short-term trend is up' : 'Short-term trend is down' });
  }

  const m = macd(closes);
  const h0 = last(m.hist);
  const h1 = prev(m.hist);
  if (h1 <= 0 && h0 > 0) parts.push({ pts: 22, why: 'MACD momentum turned positive' });
  else if (h1 >= 0 && h0 < 0) parts.push({ pts: -22, why: 'MACD momentum turned negative' });
  else if (Math.abs(h0) > vol * 0.05) parts.push({ pts: h0 > 0 ? (h0 > h1 ? 12 : 4) : h0 < h1 ? -12 : -4, why: h0 > 0 ? 'MACD momentum is positive' : 'MACD momentum is negative' });

  const r = rsi(closes, 14);
  const r0 = last(r);
  const r1 = prev(r);
  if (r0 < 30) parts.push({ pts: r0 > r1 ? 25 : 10, why: `RSI ${f1(r0)} is oversold${r0 > r1 ? ' and turning up' : ''}` });
  else if (r0 > 70) parts.push({ pts: r0 < r1 ? -25 : -10, why: `RSI ${f1(r0)} is overbought${r0 < r1 ? ' and turning down' : ''}` });
  else if (r0 > 55 && r0 > r1) parts.push({ pts: 8, why: `RSI ${f1(r0)} is rising` });
  else if (r0 < 45 && r0 < r1) parts.push({ pts: -8, why: `RSI ${f1(r0)} is falling` });

  const bb = bollinger(closes, 20, 2);
  if (price < last(bb.lower)) parts.push({ pts: 15, why: 'Price is stretched below the lower Bollinger Band' });
  else if (price > last(bb.upper)) parts.push({ pts: -15, why: 'Price is stretched above the upper Bollinger Band' });

  let score = parts.reduce((s, p) => s + p.pts, 0);

  const trendUp = price > last(trendLine);
  if ((score > 0 && !trendUp) || (score < 0 && trendUp)) {
    score *= 0.7;
    parts.push({ pts: 0, why: `Against the 50 EMA trend (${trendUp ? 'up' : 'down'}), confidence reduced` });
  }

  const vols = candles.map((c) => c.volume);
  const avgVol = last(sma(vols.slice(0, -1), 20));
  const v0 = last(vols);
  if (avgVol > 0 && v0 > avgVol * 1.5 && score !== 0) {
    score *= 1.2;
    parts.push({ pts: 0, why: `Volume is ${f1(v0 / avgVol)}× the average, confirming the move` });
  }

  score = clamp(score, -100, 100);
  const reasons = parts
    .slice()
    .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .map((p) => p.why);
  return { score, ready: true, reasons: reasons.length ? reasons : ['No clear signal — indicators are neutral'] };
}

/** Donchian channel breakout: a close beyond the last 20 candles' range starts a move. */
function breakout(candles: Candle[]): Signal {
  const n = 20;
  const prior = candles.slice(-n - 1, -1);
  const hi = Math.max(...prior.map((c) => c.high));
  const lo = Math.min(...prior.map((c) => c.low));
  const c0 = candles[candles.length - 1];
  const avgVol = prior.reduce((s, c) => s + c.volume, 0) / prior.length;
  const loud = avgVol > 0 && c0.volume > avgVol * 1.3;
  const volNote = loud ? ` on ${f1(c0.volume / avgVol)}× average volume` : '';
  if (c0.close > hi) return { score: loud ? 90 : 75, ready: true, reasons: [`Closed above the 20-candle high of ${hi.toFixed(2)}${volNote}`] };
  if (c0.close < lo) return { score: loud ? -90 : -75, ready: true, reasons: [`Closed below the 20-candle low of ${lo.toFixed(2)}${volNote}`] };
  const pos = (c0.close - (hi + lo) / 2) / ((hi - lo) / 2 || 1);
  return { score: clamp(pos * 30, -30, 30), ready: true, reasons: [`Inside the 20-candle range (${lo.toFixed(2)} – ${hi.toFixed(2)})`] };
}

/** Buy dips in an uptrend and sell rallies in a downtrend, timed by RSI turning. */
function pullback(candles: Candle[]): Signal {
  const closes = candles.map((c) => c.close);
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const price = last(closes);
  const r = rsi(closes, 14);
  const r0 = last(r);
  const r1 = prev(r);
  const up = price > e200 && e50 > e200;
  const down = price < e200 && e50 < e200;
  if (up && r1 < 40 && r0 > r1) return { score: 80, ready: true, reasons: [`Uptrend pullback: RSI turned up from ${f1(r1)}`, 'Price and 50 EMA are above the 200 EMA'] };
  if (down && r1 > 60 && r0 < r1) return { score: -80, ready: true, reasons: [`Downtrend rally fading: RSI turned down from ${f1(r1)}`, 'Price and 50 EMA are below the 200 EMA'] };
  if (up) return { score: 15, ready: true, reasons: [`Uptrend, waiting for a pullback (RSI ${f1(r0)})`] };
  if (down) return { score: -15, ready: true, reasons: [`Downtrend, waiting for a rally to sell (RSI ${f1(r0)})`] };
  return { score: 0, ready: true, reasons: ['No clear trend'] };
}

/** The checklist verdict, in the shape the trading rules take: buy +100, sell −100, hold 0. */
function chartReader(candles: Candle[]): Signal {
  const read = readChart(candles);
  const failing = read.entry.filter((c) => !c.ok).map((c) => c.label);
  const exits = read.exit.filter((c) => c.ok).map((c) => c.label);
  const reasons =
    read.action === 'buy' ? ['Every buy check passed'] : read.action === 'sell' ? exits : [`Waiting for: ${failing.join(', ').toLowerCase()}`];
  return {
    score: read.action === 'buy' ? 100 : read.action === 'sell' ? -100 : 0,
    ready: read.ready,
    reasons,
    action: read.action,
    checks: { entry: read.entry, exit: read.exit },
  };
}

const IMPL: Record<StrategyId, (c: Candle[]) => Signal> = {
  smart: smartBlend,
  ema: emaCross,
  rsi: rsiReversion,
  bollinger: bandBounce,
  macd: macdMomentum,
  breakout,
  pullback,
  chart: chartReader,
};

export function evaluate(strategy: StrategyId, candles: Candle[]): Signal {
  const info = strategyInfo(strategy);
  if (candles.length < info.minBars) return notReady(info, candles.length);
  const window = candles.slice(-300);
  const sig = IMPL[strategy](window);
  return { ...sig, score: Number.isFinite(sig.score) ? Math.round(sig.score) : 0, ...context(window) };
}

/** Volatility and trend context the trading rules use, whatever the strategy. */
function context(candles: Candle[]): Pick<Signal, 'atrPct' | 'trend'> {
  const price = candles[candles.length - 1].close;
  const a = last(atr(candles, 14));
  const atrPct = Number.isFinite(a) && price > 0 ? (a / price) * 100 : undefined;
  if (candles.length < 200) return { atrPct, trend: 0 };
  const closes = candles.map((c) => c.close);
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const trend = price > e200 && e50 > e200 ? 1 : price < e200 && e50 < e200 ? -1 : 0;
  return { atrPct, trend };
}
