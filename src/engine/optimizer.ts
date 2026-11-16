import type { BotSettings, Candle, StrategyId } from '../types';
import { STRATEGIES } from '../lib/strategies';
import { WARMUP_BARS, aggregate, computeSignals, lowerBound, runBacktest, tfSeconds, type BacktestStats, type BacktestTimeframe } from './backtest';

/**
 * Searches bot settings on a tuning period, then checks the winners on a later period
 * the search never saw. The tuning period is split in two and settings are ranked by
 * their worse half, so a setting has to work in both to rank well.
 */

export interface Tuned {
  strategy: StrategyId;
  timeframe: BacktestTimeframe;
  minConfidence: number;
  stopAtr: number;
  targetAtr: number;
  trailingStop: boolean;
  trendFilter: boolean;
  exitOnSignal: boolean;
  allowShort: boolean;
}

export interface Candidate {
  tuned: Tuned;
  /** Whole tuning period. */
  train: BacktestStats;
  /** Worse of the two tuning halves, in percent. */
  worstHalf: number;
  test: BacktestStats;
}

export interface OptimizeInput {
  base: Candle[];
  start: number;
  trainEnd: number;
  end: number;
  startCash: number;
  settings: BotSettings;
  grid?: Partial<{ [K in keyof Tuned]: Tuned[K][] }>;
}

export const DEFAULT_GRID: { [K in keyof Tuned]: Tuned[K][] } = {
  strategy: STRATEGIES.map((s) => s.id),
  timeframe: ['15m', '1h', '4h'],
  minConfidence: [50, 70],
  stopAtr: [1.5, 2.5, 4],
  targetAtr: [0, 3, 6],
  trailingStop: [true, false],
  trendFilter: [true, false],
  exitOnSignal: [true, false],
  allowShort: [false, true],
};

export function gridSize(grid = DEFAULT_GRID) {
  return Object.values(grid).reduce((n, v) => n * v.length, 1);
}

/** The settings a tuned row stands for: volatility stops and the fee filter are always on in the search. */
export function tunedSettings(base: BotSettings, t: Tuned): BotSettings {
  const { timeframe: _tf, ...rest } = t;
  return { ...base, ...rest, stopMode: 'atr', feeFilter: true };
}

export function optimize(input: OptimizeInput, onProgress?: (done: number, total: number) => void): Candidate[] {
  const grid = { ...DEFAULT_GRID, ...input.grid };
  const total = gridSize(grid);
  const mid = Math.round((input.start + input.trainEnd) / 2 / 3600) * 3600;
  const out: Candidate[] = [];
  let done = 0;

  for (const timeframe of grid.timeframe) {
    const bars = aggregate(input.base, tfSeconds(timeframe));
    const from = Math.max(0, lowerBound(bars, input.start) - 1);
    if (from < Math.min(WARMUP_BARS, 200) - 1) {
      // Not enough history before the window for this candle size; skip rather than trade half-blind.
      done += total / grid.timeframe.length;
      continue;
    }
    for (const strategy of grid.strategy) {
      const signals = computeSignals(strategy, bars, from);
      for (const minConfidence of grid.minConfidence)
        for (const stopAtr of grid.stopAtr)
          for (const targetAtr of grid.targetAtr)
            for (const trailingStop of grid.trailingStop)
              for (const trendFilter of grid.trendFilter)
                for (const exitOnSignal of grid.exitOnSignal)
                  for (const allowShort of grid.allowShort) {
                    const tuned: Tuned = { strategy, timeframe, minConfidence, stopAtr, targetAtr, trailingStop, trendFilter, exitOnSignal, allowShort };
                    const settings = tunedSettings(input.settings, tuned);
                    const common = { base: input.base, timeframe, settings, startCash: input.startCash, bars, signals, quiet: true };
                    const a = runBacktest({ ...common, start: input.start, end: mid }).stats;
                    const b = runBacktest({ ...common, start: mid, end: input.trainEnd }).stats;
                    const train = runBacktest({ ...common, start: input.start, end: input.trainEnd }).stats;
                    const test = runBacktest({ ...common, start: input.trainEnd, end: input.end }).stats;
                    const enough = a.trades >= 3 && b.trades >= 3;
                    out.push({ tuned, train, test, worstHalf: enough ? Math.min(a.returnPct, b.returnPct) : -1e9 + a.trades + b.trades });
                    if (++done % 64 === 0) onProgress?.(done, total);
                  }
    }
  }
  onProgress?.(total, total);
  return out.sort((x, y) => y.worstHalf - x.worstHalf || y.train.returnPct - x.train.returnPct);
}

export const warmupSeconds = (tf: BacktestTimeframe) => WARMUP_BARS * tfSeconds(tf);
