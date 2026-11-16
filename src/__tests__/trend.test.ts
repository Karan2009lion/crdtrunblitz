import { describe, expect, it } from 'vitest';
import { DAY, DEFAULT_TREND, dailyCloses, runTrendBacktest, trendTarget } from '../engine/trend';
import type { Candle } from '../types';

const days = (closes: number[]): Candle[] => closes.map((c, i) => ({ time: i * DAY, open: c, high: c, low: c, close: c, volume: 1 }));
const wiggle = (n: number, drift: number) => Array.from({ length: n }, (_, i) => 100 * (1 + drift) ** i * (1 + 0.01 * Math.sin(i)));

describe('trend mode', () => {
  it('waits for enough history', () => {
    expect(trendTarget(wiggle(50, 0.001)).ready).toBe(false);
  });

  it('goes long in an uptrend, sized down by volatility', () => {
    const t = trendTarget(wiggle(200, 0.004));
    expect(t.signal).toBe(1);
    expect(t.weight).toBeGreaterThan(0);
    expect(t.weight).toBeCloseTo(Math.min(1, 0.25 / (t.volPct / 100)), 6);
  });

  it('shorts a downtrend, or stays in cash when long only', () => {
    const down = wiggle(200, -0.004);
    expect(trendTarget(down).weight).toBeLessThan(0);
    expect(trendTarget(down, { ...DEFAULT_TREND, longOnly: true }).weight).toBe(0);
  });

  it('takes the last close of each day', () => {
    const c: Candle[] = [0, 3600, DAY, DAY + 60].map((time, i) => ({ time, open: i, high: i, low: i, close: i, volume: 1 }));
    expect(dailyCloses(c)).toEqual([
      { day: 0, close: 1 },
      { day: DAY, close: 3 },
    ]);
  });

  it('earns the trend minus costs, and only trades when the target moves', () => {
    const closes = wiggle(400, 0.003);
    const base = days(closes);
    const r = runTrendBacktest(base, 200 * DAY, 400 * DAY, 10_000, 0.12);
    expect(r.stats.returnPct).toBeGreaterThan(0);
    expect(r.stats.fees).toBeGreaterThan(0);
    expect(r.rebalances.length).toBeLessThan(40);
    for (const rb of r.rebalances) expect(Math.abs(rb.toWeight - rb.fromWeight)).toBeGreaterThan(DEFAULT_TREND.band - 1e-9);
    // Without costs the result is at least as good.
    const free = runTrendBacktest(base, 200 * DAY, 400 * DAY, 10_000, 0);
    expect(free.stats.endEquity).toBeGreaterThanOrEqual(r.stats.endEquity);
  });
});
