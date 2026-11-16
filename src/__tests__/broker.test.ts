import { describe, expect, it } from 'vitest';
import type { Position } from '../types';
import { adjustPosition, closePosition, equity, openPosition, protectiveExit, trail } from '../engine/broker';

const base = { time: 0, feePct: 0.1, slippagePct: 0, stopLossPct: 1, takeProfitPct: 2, by: 'bot' as const, reason: 'test' };

describe('paper broker', () => {
  it('opens and closes a long with fees', () => {
    const o = openPosition({ cash: 10000, positions: [] }, { ...base, symbol: 'BTCUSDT', side: 'long', amount: 1000, price: 100 });
    if (!o.ok) throw new Error(o.error);
    expect(o.account.cash).toBeCloseTo(10000 - 1000 - 1);
    expect(o.position.qty).toBeCloseTo(10);
    expect(o.position.stopLoss).toBeCloseTo(99);
    expect(o.position.takeProfit).toBeCloseTo(102);
    expect(equity(o.account, { BTCUSDT: 110 })).toBeCloseTo(8999 + 1100);

    const c = closePosition(o.account, { positionId: o.position.id, price: 110, time: 1, feePct: 0.1, slippagePct: 0, reason: 'x' });
    if (!c.ok) throw new Error(c.error);
    expect(c.trade.pnl).toBeCloseTo(100 - 1 - 1.1);
    expect(c.account.cash).toBeCloseTo(10000 + c.trade.pnl);
    expect(c.account.positions).toHaveLength(0);
  });

  it('short positions profit when price falls', () => {
    const o = openPosition({ cash: 10000, positions: [] }, { ...base, feePct: 0, symbol: 'ETHUSDT', side: 'short', amount: 1000, price: 100 });
    if (!o.ok) throw new Error(o.error);
    expect(o.position.stopLoss).toBeCloseTo(101);
    expect(o.position.takeProfit).toBeCloseTo(98);
    const c = closePosition(o.account, { positionId: o.position.id, price: 90, time: 1, feePct: 0, slippagePct: 0, reason: 'x' });
    if (!c.ok) throw new Error(c.error);
    expect(c.trade.pnl).toBeCloseTo(100);
    expect(c.account.cash).toBeCloseTo(10100);
  });

  it('refuses trades it cannot afford or duplicates', () => {
    const o = openPosition({ cash: 500, positions: [] }, { ...base, symbol: 'A', side: 'long', amount: 1000, price: 10 });
    expect(o.ok).toBe(false);
    const a = openPosition({ cash: 5000, positions: [] }, { ...base, symbol: 'A', side: 'long', amount: 1000, price: 10 });
    if (!a.ok) throw new Error();
    expect(openPosition(a.account, { ...base, symbol: 'A', side: 'long', amount: 1000, price: 10 }).ok).toBe(false);
  });

  it('triggers stops and ratchets the trailing stop', () => {
    const o = openPosition({ cash: 10000, positions: [] }, { ...base, symbol: 'A', side: 'long', amount: 1000, price: 100 });
    if (!o.ok) throw new Error();
    const p = o.position;
    expect(protectiveExit(p, 99.5)).toBeNull();
    expect(protectiveExit(p, 98.9)?.reason).toBe('Stop loss hit');
    expect(protectiveExit(p, 102.1)?.reason).toBe('Take profit hit');
    const t = trail(p, 101.5, 1)!;
    expect(t.stopLoss).toBeCloseTo(100.485);
    expect(trail({ ...p, ...t }, 101, 1)).toBeNull();
    expect(protectiveExit({ ...p, ...t }, 100.4)?.reason).toMatch(/Trailing/);
  });
});

describe('adjusting a position', () => {
  const req = { symbol: 'X', time: 0, feePct: 0.1, slippagePct: 0, by: 'bot' as const, reason: 'Trend rebalance' };

  it('opens, adds and trims while keeping the books balanced', () => {
    let acc: { cash: number; positions: Position[] } = { cash: 10_000, positions: [] };
    acc = adjustPosition(acc, { ...req, side: 'long', notional: 4_000, price: 100 }).account;
    expect(acc.positions[0].qty).toBeCloseTo(40);
    acc = adjustPosition(acc, { ...req, side: 'long', notional: 6_000, price: 100 }).account;
    expect(acc.positions[0].qty).toBeCloseTo(60);
    expect(acc.positions[0].entryPrice).toBeCloseTo(100);
    // Price rises 10%; trim to $3,300 (half of the $6,600 held).
    const r = adjustPosition(acc, { ...req, side: 'long', notional: 3_300, price: 110 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].qty).toBeCloseTo(30);
    expect(r.trades[0].pnl).toBeCloseTo(30 * 10 - 3 - 3.3, 6); // gain minus entry and exit fee shares
    acc = r.account;
    expect(acc.positions[0].qty).toBeCloseTo(30);
    // Closing the rest returns everything: start cash + gains − all fees.
    const done = adjustPosition(acc, { ...req, side: 'long', notional: 0, price: 110 }).account;
    expect(done.positions).toHaveLength(0);
    expect(done.cash).toBeCloseTo(10_000 + 60 * 10 - 6 - 6.6, 6);
  });

  it('flips from long to short', () => {
    let acc = adjustPosition({ cash: 10_000, positions: [] }, { ...req, side: 'long', notional: 5_000, price: 100 }).account;
    const r = adjustPosition(acc, { ...req, side: 'short', notional: 2_000, price: 90 });
    acc = r.account;
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].pnl).toBeLessThan(0);
    expect(acc.positions[0].side).toBe('short');
    expect(acc.positions[0].collateral).toBeCloseTo(2_000);
  });

  it('trims a short and realises its gain', () => {
    let acc = adjustPosition({ cash: 10_000, positions: [] }, { ...req, side: 'short', notional: 4_000, price: 100 }).account;
    const r = adjustPosition(acc, { ...req, side: 'short', notional: 1_800, price: 90 });
    acc = r.account;
    expect(r.trades[0].qty).toBeCloseTo(20);
    expect(r.trades[0].pnl).toBeCloseTo(20 * 10 - 2 - 1.8, 6);
    expect(acc.positions[0].qty).toBeCloseTo(20);
  });
});
