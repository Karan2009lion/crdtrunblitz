import type { Candle } from '../types';
import { atr, ema, rsi } from '../lib/indicators';

/** The network predicts whether BTC is higher this many minutes later. */
export const HORIZON_MIN = 15;
/** Candles of history needed before the first usable row. */
export const LOOKBACK = 70;

export const FEATURE_NAMES = [
  'Move over 1 minute',
  'Move over 3 minutes',
  'Move over 5 minutes',
  'Move over 15 minutes',
  'Move over 30 minutes',
  'Move over 60 minutes',
  'Price vs 9-minute average',
  'Price vs 21-minute average',
  'Price vs 1-hour average',
  'Slope of the 9-minute average',
  'RSI',
  'Place in the 1-hour range',
  'Volatility vs the last hour',
  'Volume vs the last hour',
  'Last candle body',
] as const;
export const FEATURE_COUNT = FEATURE_NAMES.length;

const clip = (v: number, lim = 6) => (Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);

/**
 * One row of inputs per 1-minute candle (null while warming up), using only that candle and the
 * ones before it. Moves are scaled by the typical minute's range, so calm and wild markets look alike.
 */
export function featureRows(candles: Candle[]): (Float64Array | null)[] {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e60 = ema(closes, 60);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const rows: (Float64Array | null)[] = new Array(n).fill(null);
  for (let i = LOOKBACK - 1; i < n; i++) {
    const price = closes[i];
    const v = a[i] / price; // typical 1-minute move, as a fraction
    if (!(v > 0) || !Number.isFinite(e60[i])) continue;
    let hi = -Infinity;
    let lo = Infinity;
    let atrSum = 0;
    let volSum = 0;
    for (let j = i - 59; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
      atrSum += Number.isFinite(a[j]) ? a[j] : a[i];
      volSum += candles[j].volume;
    }
    const vol5 = (candles[i].volume + candles[i - 1].volume + candles[i - 2].volume + candles[i - 3].volume + candles[i - 4].volume) / 5;
    const move = (k: number) => clip(Math.log(price / closes[i - k]) / (v * Math.sqrt(k)));
    const x = new Float64Array(FEATURE_COUNT);
    x[0] = move(1);
    x[1] = move(3);
    x[2] = move(5);
    x[3] = move(15);
    x[4] = move(30);
    x[5] = move(60);
    x[6] = clip((price / e9[i] - 1) / v);
    x[7] = clip((price / e21[i] - 1) / v);
    x[8] = clip((price / e60[i] - 1) / v);
    x[9] = clip((e9[i] / e9[i - 3] - 1) / v);
    x[10] = Number.isFinite(r[i]) ? (r[i] - 50) / 50 : 0;
    x[11] = hi > lo ? ((price - lo) / (hi - lo)) * 2 - 1 : 0;
    x[12] = clip(Math.log(a[i] / (atrSum / 60)), 3);
    x[13] = clip(Math.log((vol5 + 1e-9) / (volSum / 60 + 1e-9)), 3);
    x[14] = clip((candles[i].close - candles[i].open) / price / v);
    rows[i] = x;
  }
  return rows;
}

/** 1 if the close HORIZON_MIN candles later is higher, 0 if not, null when not known yet. */
export function labelAt(candles: Candle[], i: number): 0 | 1 | null {
  const j = i + HORIZON_MIN;
  if (j >= candles.length || candles[j].time - candles[i].time !== HORIZON_MIN * 60) return null;
  return candles[j].close > candles[i].close ? 1 : 0;
}
