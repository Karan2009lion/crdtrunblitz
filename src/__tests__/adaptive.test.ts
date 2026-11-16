import { describe, expect, it } from 'vitest';
import { DAY, DEFAULT_ADAPTIVE, choose, simulateAdaptive, windowScore, type ShadowRun } from '../engine/adaptive';
import type { Candle } from '../types';

/** Hourly candles at a flat price, with optional price overrides from a given time. */
function hours(days: number, price: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let t = 0; t < days * DAY; t += 3600) {
    const p = price(t);
    out.push({ time: t, open: p, high: p, low: p, close: p, volume: 1 });
  }
  return out;
}

const o = { ...DEFAULT_ADAPTIVE, windowDays: 2, rebalanceDays: 7, topK: 1, ddPenalty: 0, minTrades: 0, feePct: 0.1, slippagePct: 0 };

describe('adaptive mode', () => {
  it('scores a window by return and drawdown', () => {
    const run: ShadowRun = { id: 1, daily: [100, 120, 90, 110], trades: [] };
    const s = windowScore(run, 0, 3);
    expect(s.ret).toBeCloseTo(10);
    expect(s.dd).toBeCloseTo(25);
  });

  it('only picks candidates that made money recently', () => {
    const up: ShadowRun = { id: 1, daily: [10_000, 10_100, 10_200, 10_300], trades: [] };
    const down: ShadowRun = { id: 2, daily: [10_000, 9_900, 9_800, 9_700], trades: [] };
    expect(choose([up, down], 0, 3 * DAY, o).map((c) => c.id)).toEqual([1]);
    expect(choose([down], 0, 3 * DAY, o)).toEqual([]);
  });

  it('copies a chosen candidate trade with its own fees', () => {
    const base = hours(12, () => 100);
    const run: ShadowRun = { id: 7, daily: [10_000, 10_100, 10_200, 10_300, 10_400, 10_500, 10_600, 10_700, 10_800, 10_900, 11_000], trades: [[5 * DAY + 3600, 6 * DAY, 1, 100, 110]] };
    const r = simulateAdaptive(base, [run], 0, 3 * DAY, 10 * DAY, o);
    expect(r.trades).toHaveLength(1);
    const notional = 10_000 / 1.001;
    const qty = notional / 100;
    const expected = 10_000 + qty * 10 - notional * 0.001 - qty * 110 * 0.001;
    expect(r.stats.endEquity).toBeCloseTo(expected, 6);
    expect(r.trades[0].pnl).toBeCloseTo(expected - 10_000, 6);
  });

  it('joins an open trade at the current price and closes it when switching away', () => {
    // Candidate 1 is long from day 1 to day 20; it stops being chosen once its shadow account falls.
    const base = hours(25, (t) => (t < 10 * DAY ? 100 : 90));
    const daily = Array.from({ length: 24 }, (_, i) => (i < 10 ? 10_000 + i * 100 : 9_000));
    const run: ShadowRun = { id: 1, daily, trades: [[1 * DAY, 20 * DAY, 1, 100, 95]] };
    const r = simulateAdaptive(base, [run], 0, 3 * DAY, 22 * DAY, { ...o, windowDays: 2, rebalanceDays: 7 });
    // Joined at day 3, re-chosen at day 10 (window days 7–9 still rising), dropped at day 17.
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entryTime).toBe(3 * DAY);
    expect(r.trades[0].switched).toBe(true);
    expect(r.trades[0].exitTime).toBe(17 * DAY);
    expect(r.trades[0].exitPrice).toBe(90);
    expect(r.stats.endEquity).toBeLessThan(10_000);
  });

  it('waits in cash when nothing is working', () => {
    const base = hours(12, () => 100);
    const run: ShadowRun = { id: 1, daily: Array.from({ length: 11 }, (_, i) => 10_000 - i * 100), trades: [[4 * DAY, 5 * DAY, 1, 100, 90]] };
    const r = simulateAdaptive(base, [run], 0, 3 * DAY, 10 * DAY, o);
    expect(r.trades).toHaveLength(0);
    expect(r.stats.endEquity).toBe(10_000);
  });
});
