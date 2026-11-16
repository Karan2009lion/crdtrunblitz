import type { Candle } from '../../src/types';

/**
 * Made-up but realistic 1-minute BTC prices in eight market moods, seeded so every run with the
 * same seed gives the same prices. Used by scenario-test.ts and loss-research.ts.
 */

/** Each mood: length in minutes, average move per minute (%), and typical size of a minute's move (%). */
export const SCENARIOS = [
  { name: 'Quiet sideways', minutes: 300, driftPct: 0, volPct: 0.03 },
  { name: 'Steady climb', minutes: 300, driftPct: 0.012, volPct: 0.1 },
  { name: 'Choppy sideways', minutes: 300, driftPct: 0, volPct: 0.12 },
  { name: 'Sudden crash', minutes: 30, driftPct: -0.15, volPct: 0.25 },
  { name: 'Slow decline', minutes: 300, driftPct: -0.01, volPct: 0.1 },
  { name: 'Strong pump', minutes: 120, driftPct: 0.04, volPct: 0.15 },
  { name: 'Wild swings', minutes: 240, driftPct: 0, volPct: 0.2 },
  { name: 'Recovery climb', minutes: 300, driftPct: 0.01, volPct: 0.1 },
];
/** The bot starts once it has this many minutes of history (all in the quiet period). */
export const WARMUP = 200;

function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

/** 1-minute candles: each minute is six small random steps, so highs and lows look real. */
export function makePrices(seed: number, start = 80_000, t0 = 1_793_000_000 - (1_793_000_000 % 60)) {
  const r = rng(seed);
  const candles: (Candle & { scenario: number })[] = [];
  let price = start;
  let t = t0;
  SCENARIOS.forEach((s, k) => {
    for (let m = 0; m < s.minutes; m++) {
      const open = price;
      let hi = open;
      let lo = open;
      for (let step = 0; step < 6; step++) {
        price *= 1 + (s.driftPct / 100) / 6 + ((s.volPct / 100) / Math.sqrt(6)) * r.normal();
        hi = Math.max(hi, price);
        lo = Math.min(lo, price);
      }
      const move = Math.abs(price / open - 1) / (s.volPct / 100);
      const volume = +(20 * (0.6 + 0.4 * move + 0.5 * r.uniform())).toFixed(3);
      candles.push({ time: t, open, high: hi, low: lo, close: price, volume, scenario: k });
      t += 60;
    }
  });
  return candles;
}

