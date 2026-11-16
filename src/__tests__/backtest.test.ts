import { describe, expect, it } from 'vitest';
import { aggregate, computeSignals, runBacktest, signalAt } from '../engine/backtest';
import { evaluate } from '../lib/strategies';
import { CLASSIC_SETTINGS, DEFAULT_CONTROLS, SETTINGS, checkControls, inHours, settingsFor, startCash } from '../store/useStore';
import { decide } from '../engine/rules';
import type { BotSettings, Candle } from '../types';

function minutes(n: number, f: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = f(i);
    const c = f(i + 1);
    return { time: 1_699_999_800 + i * 60, open: o, high: Math.max(o, c) * 1.0005, low: Math.min(o, c) * 0.9995, close: c, volume: 10 };
  });
}

const settings: BotSettings = { ...CLASSIC_SETTINGS, tradeAmount: 10_000, budget: 10_000, maxLoss: 0 };

describe('backtest', () => {
  it('aggregates minutes into larger candles', () => {
    const base = minutes(30, (i) => 100 + i);
    const five = aggregate(base, 300);
    expect(five).toHaveLength(6);
    expect(five[0].open).toBe(base[0].open);
    expect(five[0].close).toBe(base[4].close);
    expect(five[0].high).toBe(Math.max(...base.slice(0, 5).map((c) => c.high)));
  });

  it('keeps the books balanced: final cash equals start plus every trade result', () => {
    const base = minutes(6000, (i) => 100 + 8 * Math.sin(i / 90) + 3 * Math.sin(i / 17));
    const r = runBacktest({ base, start: base[1500].time, timeframe: '5m', settings: { ...settings, allowShort: true }, startCash: 10_000 });
    expect(r.trades.length).toBeGreaterThan(2);
    const sum = r.trades.reduce((s, t) => s + t.pnl, 0);
    expect(r.stats.endEquity).toBeCloseTo(10_000 + sum, 6);
    expect(r.fills.length).toBe(r.trades.length * 2);
    for (const t of r.trades) expect(t.exitTime).toBeGreaterThanOrEqual(t.entryTime);
  });

  it('fills a gapped stop at the open, not at the stop price', () => {
    // Steady rise so the bot buys, then the market opens 5% lower (a gap between candles).
    const base = minutes(800, (i) => 100 + i * 0.02).map((c, i) =>
      i >= 700 ? { ...c, open: c.open * 0.95, high: c.high * 0.95, low: c.low * 0.95, close: c.close * 0.95 } : c,
    );
    const r = runBacktest({ base, start: base[400].time, timeframe: '1m', settings: { ...settings, strategy: 'ema', minConfidence: 20, stopLossPct: 1, takeProfitPct: 0, cooldownSec: 0 }, startCash: 10_000 });
    const gapped = r.trades.find((t) => t.exitTime === (base[700].time + 60) * 1000);
    expect(gapped).toBeDefined();
    // The stop sat about 1% under the peak; the fill is at the gapped open, minus slippage.
    expect(gapped!.exitPrice).toBeCloseTo(base[700].open * (1 - settings.slippagePct / 100), 6);
  });

  it('a time limit closes each trade within 30 minutes, and a 30-minute wait keeps it to one trade an hour', () => {
    const base = minutes(6000, (i) => 100 + 8 * Math.sin(i / 90) + 3 * Math.sin(i / 17));
    const st: BotSettings = { ...SETTINGS, strategy: 'ema', stopAtr: 1, targetAtr: 1.5, allowShort: false, feeFilter: false, maxHoldMin: 30, cooldownSec: 1800 };
    const r = runBacktest({ base, start: base[1500].time, timeframe: '30m', settings: st, startCash: 10_000 });
    expect(r.trades.length).toBeGreaterThan(2);
    for (const t of r.trades) expect(t.exitTime - t.entryTime).toBeLessThanOrEqual(30 * 60_000);
    expect(r.trades.some((t) => t.exitReason === 'Held 30 minutes')).toBe(true);
    for (let i = 1; i < r.trades.length; i++) expect(r.trades[i].entryTime - r.trades[i - 1].entryTime).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it('sizes each trade so its stop loses the set share of the account, fees included', () => {
    for (const account of [{ currency: 'USD' as const, rate: 1 }, { currency: 'INR' as const, rate: 95 }]) {
      for (const cash of [startCash(account), 100]) {
        const st = settingsFor(account);
        const d = decide({ signal: { score: 90, ready: true, reasons: ['x'], atrPct: 1 }, settings: st, cash, equity: cash, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
        expect(d.kind).toBe('enter');
        if (d.kind !== 'enter') continue;
        // Stop 2.5 × ATR = 2.5%, plus 0.24% round-trip costs: losing the stop costs 0.5% of the account.
        const lossAtStop = d.amount * (d.stopPct + 0.24) / 100;
        expect(lossAtStop).toBeCloseTo(cash * 0.005, 1);
        expect(d.amount).toBeLessThan(cash);
      }
    }
  });

  it('real trading never shorts and never spends more than the cap', () => {
    const account = { currency: 'USD' as const, rate: 1 };
    const controls = { ...DEFAULT_CONTROLS, maxSpend: 50, riskPct: 5 };
    const st = settingsFor(account, controls, 'live');
    expect(st.allowShort).toBe(false);
    const buy = decide({ signal: { score: 90, ready: true, reasons: ['x'], atrPct: 1 }, settings: st, cash: 1000, equity: 1000, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
    expect(buy.kind === 'enter' && buy.amount).toBe(50);
    const short = decide({ signal: { score: -90, ready: true, reasons: ['x'], atrPct: 1 }, settings: st, cash: 1000, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
    expect(short.kind).toBe('idle');
    expect(checkControls({ ...DEFAULT_CONTROLS }, 'live')).toMatch(/most-to-spend/);
  });

  it('trading hours, including a window past midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m).getTime();
    expect(inHours(null, at(12))).toBe(true);
    expect(inHours({ from: 3, to: 5 }, at(3))).toBe(true);
    expect(inHours({ from: 3, to: 5 }, at(4, 59))).toBe(true);
    expect(inHours({ from: 3, to: 5 }, at(5))).toBe(false);
    expect(inHours({ from: 22, to: 2 }, at(23))).toBe(true);
    expect(inHours({ from: 22, to: 2 }, at(1))).toBe(true);
    expect(inHours({ from: 22, to: 2 }, at(12))).toBe(false);
    expect(checkControls({ ...DEFAULT_CONTROLS, hours: { from: 3, to: 3 } }, 'paper')).not.toBeNull();
    expect(checkControls({ ...DEFAULT_CONTROLS, dailyTrades: 15, hours: { from: 3, to: 4 } }, 'paper')).toBeNull();
  });

  it('a full-cap trade still fits after fees', () => {
    const d = decide({
      signal: { score: 90, ready: true, reasons: ['x'] },
      settings: { ...settings, feePct: 0.1 },
      cash: 10_000,
      botInvested: 0,
      recentEntries: 0,
      msSinceExit: Infinity,
    });
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') expect(d.amount * 1.001).toBeLessThanOrEqual(10_000);
  });

  it('precomputed signals carry the same volatility and trend as a live evaluation', () => {
    const base = minutes(3000, (i) => 100 + i * 0.01 + Math.sin(i / 7));
    const bars = aggregate(base, 300);
    const series = computeSignals('smart', bars, 0);
    const i = bars.length - 1;
    const live = evaluate('smart', bars.slice(i - 299, i + 1));
    const pre = signalAt(series, i);
    expect(pre.score).toBe(live.score);
    expect(pre.atrPct).toBeCloseTo(live.atrPct!, 10);
    expect(pre.trend).toBe(live.trend);
    expect(pre.trend).toBe(1);
  });

  it('uses volatility-based stops when asked', () => {
    const base = minutes(6000, (i) => 100 + 8 * Math.sin(i / 90) + 3 * Math.sin(i / 17));
    const common = { base, start: base[1500].time, timeframe: '5m' as const, startCash: 10_000 };
    const tight = runBacktest({ ...common, settings: { ...settings, stopMode: 'atr', stopAtr: 1, exitOnSignal: false } });
    const wide = runBacktest({ ...common, settings: { ...settings, stopMode: 'atr', stopAtr: 6, exitOnSignal: false } });
    expect(tight.trades.length).toBeGreaterThan(0);
    expect(tight.stats.netPnl).not.toBeCloseTo(wide.stats.netPnl, 2);
  });
});
