import { describe, expect, it } from 'vitest';
import type { Candle } from '../types';
import { FEATURE_COUNT, HORIZON_MIN, featureRows, labelAt } from '../ai/features';
import { createNet, observe, predict, train } from '../ai/net';
import { createLearner, learnFromHistory, onCandleClosed } from '../ai/learner';

function minutes(n: number, f: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = f(i);
    const c = f(i + 1);
    return { time: 1_700_000_040 + i * 60, open: o, high: Math.max(o, c) * 1.0004, low: Math.min(o, c) * 0.9996, close: c, volume: 5 + (i % 7) };
  });
}

describe('AI', () => {
  it('learns a simple rule: the sign of the first input', () => {
    const net = createNet(3);
    let seed = 1;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const data = Array.from({ length: 3000 }, () => [r(), r(), r()]);
    for (const x of data) observe(net, x);
    for (let e = 0; e < 3; e++) for (const x of data) train(net, x, x[0] > 0 ? 1 : 0);
    expect(predict(net, [0.8, 0, 0])).toBeGreaterThan(0.8);
    expect(predict(net, [-0.8, 0, 0])).toBeLessThan(0.2);
  });

  it('builds rows from past candles only and labels them 15 minutes ahead', () => {
    const c = minutes(300, (i) => 100 + Math.sin(i / 20) * 2);
    const rows = featureRows(c);
    expect(rows[10]).toBeNull();
    expect(rows[200]).toHaveLength(FEATURE_COUNT);
    // Changing a later candle must not change an earlier row.
    const changed = [...c];
    changed[250] = { ...changed[250], close: 500 };
    expect(Array.from(featureRows(changed)[200]!)).toEqual(Array.from(rows[200]!));
    expect(labelAt(c, 200)).toBe(c[200 + HORIZON_MIN].close > c[200].close ? 1 : 0);
    expect(labelAt(c, 295)).toBeNull();
  });

  it('first training is tested on newer minutes it never saw, and live calls are only scored when made in real time', () => {
    const c = minutes(3000, (i) => 100 + Math.sin(i / 37) * 3 + Math.sin(i / 11));
    let s = learnFromHistory(createLearner(), c.slice(0, 2000));
    expect(s.historyCheck!.calls).toBeGreaterThan(300);
    expect(s.samples).toBeGreaterThan(1500);
    expect(s.live.calls).toBe(0);
    // Minute by minute, as live: each call is checked 15 minutes later, once.
    for (let i = 2000; i < 2100; i++) s = onCandleClosed(s, c.slice(i - 400, i + 1));
    expect(s.latest!.time).toBe(c[2099].time);
    expect(s.live.calls).toBe(100 - HORIZON_MIN);
    expect(s.pending.every((p) => p.time > s.trainedUntil)).toBe(true);
    // Replaying the same minutes adds nothing.
    const again = onCandleClosed(s, c.slice(1700, 2100));
    expect(again.live.calls).toBe(s.live.calls);
    expect(again.samples).toBe(s.samples);
  });
});
