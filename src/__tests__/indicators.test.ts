import { describe, expect, it } from 'vitest';
import { bollinger, ema, rsi, sma } from '../lib/indicators';
import { evaluate } from '../lib/strategies';
import type { Candle } from '../types';

describe('indicators', () => {
  it('sma and ema seed from the first full window', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[1]).toBeNaN();
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });

  it('rsi is 100 for only gains and near 0 for only losses', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = up.slice().reverse();
    expect(rsi(up).at(-1)).toBe(100);
    expect(rsi(down).at(-1)).toBeLessThan(1);
  });

  it('bollinger bands surround the mean', () => {
    const v = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i));
    const bb = bollinger(v, 20, 2);
    expect(bb.upper.at(-1)!).toBeGreaterThan(bb.mid.at(-1)!);
    expect(bb.lower.at(-1)!).toBeLessThan(bb.mid.at(-1)!);
  });
});

const bars = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: i * 60, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 100 }));

describe('strategies', () => {
  it('reports warm-up until enough candles exist', () => {
    const s = evaluate('smart', bars([1, 2, 3]));
    expect(s.ready).toBe(false);
    expect(s.score).toBe(0);
  });

  it('trend follower fires on a fresh golden cross', () => {
    const closes = [...Array.from({ length: 40 }, (_, i) => 100 - i * 0.5), ...Array.from({ length: 12 }, (_, i) => 80 + i * 1.5)];
    const scores = closes.map((_, i) => (i >= 23 ? evaluate('ema', bars(closes.slice(0, i + 1))).score : 0));
    expect(Math.max(...scores)).toBe(80);
  });

  it('all strategies return a bounded score', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.05);
    for (const id of ['smart', 'ema', 'rsi', 'bollinger', 'macd'] as const) {
      const s = evaluate(id, bars(closes));
      expect(s.ready).toBe(true);
      expect(Math.abs(s.score)).toBeLessThanOrEqual(100);
      expect(s.reasons.length).toBeGreaterThan(0);
    }
  });
});
