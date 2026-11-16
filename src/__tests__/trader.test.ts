import { describe, expect, it } from 'vitest';
import type { Candle, Trade } from '../types';
import { ledger, INDIA_RATE } from '../lib/tax';
import { createLessons, learnFromHistory, lessonVerdict, lossCause, recordLesson, situationOf } from '../trader/lessons';
import { TRADER_SETTINGS } from '../store/useStore';

const trade = (pnl: number, fees: number, side: 'long' | 'short' = 'long'): Trade => ({
  id: String(Math.random()),
  symbol: 'BTCUSDT',
  side,
  qty: 0.01,
  entryPrice: 100_000,
  exitPrice: 100_000,
  entryTime: 0,
  exitTime: 3_600_000,
  pnl,
  pnlPct: 0,
  fees,
  openedBy: 'bot',
  entryReason: '',
  exitReason: 'Stop loss hit',
});

describe('fees and tax', () => {
  it('splits profit into before fees, fees and after fees', () => {
    const l = ledger([trade(90, 10), trade(-60, 10)], { tax: 'none', taxPct: 0 });
    expect(l.gross).toBeCloseTo(50);
    expect(l.fees).toBeCloseTo(20);
    expect(l.net).toBeCloseTo(30);
    expect(l.tax).toBe(0);
  });

  it('India: taxes each winning trade before fees, and losses do not reduce it', () => {
    const l = ledger([trade(90, 10), trade(-60, 10)], { tax: 'india', taxPct: 0 });
    expect(l.tax).toBeCloseTo(100 * INDIA_RATE);
    expect(l.afterTax).toBeCloseTo(30 - 100 * INDIA_RATE);
    expect(l.tds).toBeCloseTo(2 * 0.01 * 1000);
  });

  it('flat rate: on the total profit after losses', () => {
    expect(ledger([trade(90, 10), trade(-60, 10)], { tax: 'flat', taxPct: 20 }).tax).toBeCloseTo(6);
    expect(ledger([trade(-60, 10)], { tax: 'flat', taxPct: 20 }).tax).toBe(0);
  });
});

describe('lessons', () => {
  it('skips a situation only after enough clearly bad results, and forgives it if it recovers', () => {
    const l = createLessons();
    const s = situationOf('long', false, true);
    for (let i = 0; i < 7; i++) recordLesson(l, s, -1);
    expect(lessonVerdict(l, s).skip).toBe(false); // too few to judge
    recordLesson(l, s, -1);
    expect(lessonVerdict(l, s).skip).toBe(true);
    for (let i = 0; i < 6; i++) recordLesson(l, s, 2.3);
    expect(lessonVerdict(l, s).skip).toBe(false);
  });

  it('learns from a chart and explains a loss', () => {
    // A rising then falling zig-zag gives momentum signals both ways.
    const bars: Candle[] = Array.from({ length: 600 }, (_, i) => {
      const p = 100_000 + 8000 * Math.sin(i / 25) + 2000 * Math.sin(i / 6);
      return { time: i * 14_400, open: p, high: p * 1.01, low: p * 0.99, close: p * 1.002, volume: 1 };
    });
    const { lessons, outcomes } = learnFromHistory(bars, TRADER_SETTINGS);
    expect(outcomes.length).toBeGreaterThan(20);
    expect(outcomes.some((o) => o.side === 'short')).toBe(true);
    const total = Object.values(lessons).reduce((n, r) => n + (r?.n ?? 0), 0);
    expect(total).toBe(outcomes.length);
    for (const o of outcomes) expect(o.r).toBeGreaterThan(-1.2);
    const t = { ...trade(-50, 2), situation: outcomes[0].situation };
    expect(lossCause(t, lessons)).toMatch(/hit the stop after 1 hours|won \d+% of \d+ times/);
  });
});

describe('timeframes and the neural network', () => {
  it('widens short-candle stops to the floor and keeps the reward the same multiple', async () => {
    const { exitLevels } = await import('../engine/rules');
    const { settingsFor, DEFAULT_CONTROLS, botSpec } = await import('../store/useStore');
    const usd = { currency: 'USD' as const, rate: 1 };
    const fast = settingsFor(usd, { ...DEFAULT_CONTROLS, timeframe: '15m' });
    expect(fast.minStopPct).toBe(3);
    const lv = exitLevels(fast, 0.3); // a 15-minute ATR of 0.3%: 2.5× = 0.75%, below the floor
    expect(lv.stopPct).toBeCloseTo(3);
    expect(lv.targetPct / lv.stopPct).toBeCloseTo(6 / 2.5);
    expect(exitLevels(fast, 2).stopPct).toBeCloseTo(5); // above the floor: unchanged
    expect(settingsFor(usd, DEFAULT_CONTROLS).minStopPct).toBeUndefined();
    expect(botSpec({ timeframe: '1h' }).barSec).toBe(3600);
    expect(botSpec({ timeframe: '1m' }).spec.find(([k]) => k === 'When it decides')![1]).toMatch(/Every minute/);
  });

  it('only filters once the signals it would have skipped have clearly lost', async () => {
    const { createBrain, learnResult, trusted, TRUST_MIN } = await import('../trader/brain');
    const b = createBrain();
    const x = new Array(14).fill(0.1);
    for (let i = 0; i < TRUST_MIN - 1; i++) learnResult(b, x, -1, true);
    expect(trusted(b)).toBe(false); // not enough skips yet
    learnResult(b, x, -1, true);
    expect(trusted(b)).toBe(true);
    for (let i = 0; i < 40; i++) learnResult(b, x, 2.3, true); // its skips start missing winners
    expect(trusted(b)).toBe(false);
    // The placebo is judged on what really happened, not on the shuffled result it trained on.
    const p = createBrain();
    for (let i = 0; i < 40; i++) learnResult(p, x, -1, true, 2.3);
    expect(trusted(p)).toBe(false);
  });

  it('trains from history in time order and learns the base rate', async () => {
    const { trainBrain, brainView, brainInputs, indicators, BRAIN_WARMUP } = await import('../trader/brain');
    const bars: Candle[] = Array.from({ length: 1500 }, (_, i) => {
      const p = 100_000 + 8000 * Math.sin(i / 25) + 2000 * Math.sin(i / 6);
      return { time: i * 900, open: p, high: p * 1.004, low: p * 0.996, close: p * 1.001, volume: 1 + (i % 7) };
    });
    const st = { ...TRADER_SETTINGS, minStopPct: 3 };
    const { outcomes } = learnFromHistory(bars, st);
    const brain = trainBrain(bars, outcomes, 900);
    expect(brain.learned).toBeGreaterThan(BRAIN_WARMUP);
    expect(brain.learned).toBeLessThanOrEqual(outcomes.length);
    // On average over the signals it saw, its estimate is close to how often they really won.
    const rate = brain.wins / brain.learned;
    const ind = indicators(bars);
    const ps = outcomes.map((o) => brainInputs(bars, ind, o.i, o.score, 900)).filter((x): x is number[] => !!x).map((x) => brainView(brain, x).p);
    const mean = ps.reduce((a, v) => a + v, 0) / ps.length;
    expect(Math.abs(mean - rate)).toBeLessThan(0.15);
  });
});

describe('learning from history without a bias toward losses', () => {
  it('drops finished signals that come after one still open', () => {
    // Steady rise, then a sharp drop at the end: early buys reach their targets; the last buys are stopped out quickly.
    const bars: Candle[] = Array.from({ length: 700 }, (_, i) => {
      const p = i < 680 ? 100_000 * (1 + i * 0.002) + 3000 * Math.sin(i / 9) : 100_000 * (1 + 680 * 0.002) * (1 - (i - 679) * 0.01);
      return { time: i * 14_400, open: p, high: p * 1.005, low: p * 0.995, close: p, volume: 1 };
    });
    const { outcomes } = learnFromHistory(bars, TRADER_SETTINGS);
    // Every kept signal came before the first one that was still open at the end.
    const times = outcomes.map((o) => o.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const lastKept = Math.max(...times);
    const exits = outcomes.map((o) => o.exitTime);
    expect(Math.max(...exits)).toBeLessThanOrEqual(bars[bars.length - 1].time + 14_400);
    expect(lastKept).toBeLessThan(bars[bars.length - 1].time);
  });
});

describe('$150 with $5–$10 a trade', () => {
  it('keeps every trade between the least and the most to spend', async () => {
    const { decide } = await import('../engine/rules');
    const { settingsFor, DEFAULT_CONTROLS, checkControls } = await import('../store/useStore');
    const usd = { currency: 'USD' as const, rate: 1, amount: 150 };
    const c = { ...DEFAULT_CONTROLS, timeframe: '1m' as const, minSpend: 5, maxSpend: 10 };
    expect(checkControls(c, 'paper')).toBeNull();
    expect(checkControls({ ...c, minSpend: 12 }, 'paper')).not.toBeNull();
    const st = settingsFor(usd, c);
    // ATR from tiny (3% floor applies) to huge (a 20% stop would size the trade under $5).
    for (const atrPct of [0.05, 1.5, 3, 8]) {
      const d = decide({ signal: { score: 90, ready: true, reasons: ['x'], atrPct }, settings: st, cash: 150, equity: 150, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
      expect(d.kind).toBe('enter');
      if (d.kind === 'enter') {
        expect(d.amount).toBeGreaterThanOrEqual(5);
        expect(d.amount).toBeLessThanOrEqual(10);
      }
    }
    // Not enough cash for the least amount: no trade.
    const poor = decide({ signal: { score: 90, ready: true, reasons: ['x'], atrPct: 1 }, settings: st, cash: 4, equity: 4, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
    expect(poor.kind).toBe('blocked');
  });
});

describe('Blitz', () => {
  it('uses its own amounts, a trailing stop and no fixed target', async () => {
    const { decide } = await import('../engine/rules');
    const { blitzSettings, settingsFor, DEFAULT_CONTROLS, checkControls } = await import('../store/useStore');
    const usd = { currency: 'USD' as const, rate: 1, amount: 150 };
    const c = { ...DEFAULT_CONTROLS, timeframe: '1m' as const, minSpend: 5, maxSpend: 10, blitzMinSpend: 20, blitzMaxSpend: 30 };
    expect(checkControls(c, 'paper')).toBeNull();
    expect(checkControls({ ...c, blitzMinSpend: 40 }, 'paper')).not.toBeNull();
    const st = blitzSettings(usd, c);
    expect(st.trailingStop).toBe(true);
    expect(st.minConfidence).toBe(30);
    const d = decide({ signal: { score: 35, ready: true, reasons: ['x'], atrPct: 0.05 }, settings: st, cash: 150, equity: 150, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') {
      expect(d.amount).toBeGreaterThanOrEqual(20);
      expect(d.amount).toBeLessThanOrEqual(30);
      expect(d.stopPct).toBeCloseTo(0.5);
      expect(d.targetPct).toBe(0);
    }
    // Normal trades keep their own $5–$10.
    const normal = decide({ signal: { score: 90, ready: true, reasons: ['x'], atrPct: 0.05 }, settings: settingsFor(usd, c), cash: 150, equity: 150, botInvested: 0, recentEntries: 0, msSinceExit: Infinity });
    expect(normal.kind === 'enter' && normal.amount).toBe(10);
  });
});
