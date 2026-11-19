import type { BotSettings, Candle, Fill, Position, Side, Signal, StrategyId, Trade } from '../types';
import { evaluate } from '../lib/strategies';
import { closePosition, openPosition, positionValue, protectiveExit, trail, type Account } from './broker';
import { decide } from './rules';
import type { TrendRebalance } from './trend';

/**
 * Replays history through the bot's real rules: the same strategies, decision function and
 * paper broker as live trading. Stops and targets are checked on every 1-minute candle using
 * its high and low; strategy signals are read when each strategy candle closes.
 */

export type BacktestTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h';
export const TIMEFRAMES: { id: BacktestTimeframe; label: string; seconds: number }[] = [
  { id: '1m', label: '1m', seconds: 60 },
  { id: '5m', label: '5m', seconds: 300 },
  { id: '15m', label: '15m', seconds: 900 },
  { id: '30m', label: '30m', seconds: 1800 },
  { id: '1h', label: '1h', seconds: 3600 },
  { id: '2h', label: '2h', seconds: 7200 },
  { id: '4h', label: '4h', seconds: 14400 },
];
export const tfSeconds = (tf: BacktestTimeframe) => TIMEFRAMES.find((t) => t.id === tf)!.seconds;

/** Strategy candles needed before the test window so indicators are settled on day one. */
export const WARMUP_BARS = 200;

export function aggregate(base: Candle[], seconds: number): Candle[] {
  if (seconds <= 60) return base;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of base) {
    const t = Math.floor(c.time / seconds) * seconds;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface SignalSeries {
  score: Int16Array;
  ready: Uint8Array;
  /** ATR as a percent of price (NaN when unknown). */
  atrPct: Float64Array;
  /** 1 uptrend, -1 downtrend, 0 unclear. */
  trend: Int8Array;
  reasons?: string[][];
  /** Chart reader: scores are verdicts (+100 buy, −100 sell, 0 hold), not points. */
  verdicts?: boolean;
}

/** Score for each strategy candle, using only that candle and the ones before it. */
export function computeSignals(strategy: StrategyId, bars: Candle[], from = 0, withReasons = false): SignalSeries {
  const score = new Int16Array(bars.length);
  const ready = new Uint8Array(bars.length);
  const atrPct = new Float64Array(bars.length).fill(NaN);
  const trend = new Int8Array(bars.length);
  const reasons: string[][] | undefined = withReasons ? new Array(bars.length) : undefined;
  for (let i = Math.max(0, from); i < bars.length; i++) {
    const sig = evaluate(strategy, bars.slice(Math.max(0, i - 299), i + 1));
    score[i] = sig.score;
    ready[i] = sig.ready ? 1 : 0;
    atrPct[i] = sig.atrPct ?? NaN;
    trend[i] = sig.trend ?? 0;
    if (reasons) reasons[i] = sig.reasons;
  }
  return { score, ready, atrPct, trend, reasons, verdicts: strategy === 'chart' };
}

/** The signal at one strategy candle, in the shape the trading rules take. */
export function signalAt(s: SignalSeries, i: number): Signal {
  const atr = s.atrPct[i];
  return {
    score: s.score[i],
    ready: s.ready[i] === 1,
    reasons: s.reasons?.[i] ?? [],
    ...(s.verdicts ? { action: s.score[i] >= 100 ? ('buy' as const) : s.score[i] <= -100 ? ('sell' as const) : ('hold' as const) } : {}),
    atrPct: Number.isNaN(atr) ? undefined : atr,
    trend: s.trend[i] as -1 | 0 | 1,
  };
}

export interface BacktestInput {
  /** 1-minute candles covering warm-up and the test window. */
  base: Candle[];
  /** Unix seconds; trading starts here. Earlier candles are warm-up only. */
  start: number;
  end?: number;
  timeframe: BacktestTimeframe;
  settings: BotSettings;
  startCash: number;
  /** Precomputed strategy candles and signals (the optimiser reuses them across runs). */
  bars?: Candle[];
  signals?: SignalSeries;
  /**
   * Optional early exit: while a trade is open, read a faster chart and close the trade as soon
   * as that chart's score turns against it by at least `threshold`.
   */
  earlyExit?: { bars: Candle[]; signals: SignalSeries; seconds: number; threshold: number };
  /** Skip the narrative log for speed. */
  quiet?: boolean;
}

export interface EquityPoint {
  time: number;
  value: number;
}

export interface BacktestLog {
  time: number;
  level: 'buy' | 'sell' | 'info' | 'warn';
  message: string;
}

export interface BacktestStats {
  startCash: number;
  endEquity: number;
  netPnl: number;
  returnPct: number;
  buyHoldPct: number;
  /** Price at the first minute of the test window, the buy-and-hold reference. */
  startPrice: number;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  best: number;
  worst: number;
  fees: number;
  maxDrawdownPct: number;
  exposurePct: number;
  longs: number;
  shorts: number;
  stoppedEarly?: string;
}

export interface BacktestResult {
  bars: Candle[];
  /** Trend mode: each daily rebalance. */
  rebalances?: TrendRebalance[];
  trades: Trade[];
  fills: Fill[];
  equity: EquityPoint[];
  log: BacktestLog[];
  stats: BacktestStats;
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const { base, start, settings: st, startCash, timeframe } = input;
  const end = input.end ?? Infinity;
  const sec = tfSeconds(timeframe);
  const bars = input.bars ?? aggregate(base, sec);
  const firstTradeBar = lowerBound(bars, start);
  const signals = input.signals ?? computeSignals(st.strategy, bars, firstTradeBar - 1, !input.quiet);
  const quiet = !!input.quiet;

  let acc: Account = { cash: startCash, positions: [] };
  const trades: Trade[] = [];
  const fills: Fill[] = [];
  const equity: EquityPoint[] = [];
  const log: BacktestLog[] = [];
  const entries: number[] = [];
  let lastExit = -Infinity;
  let stopped: string | undefined;
  let exposedMinutes = 0;
  let minutes = 0;
  let peak = startCash;
  let maxDd = 0;
  const say = (time: number, level: BacktestLog['level'], message: string) => !quiet && log.push({ time, level, message });

  const fee = st.feePct;
  const slip = st.slippagePct;

  const close = (pos: Position, price: number, timeMs: number, reason: string) => {
    const r = closePosition(acc, { positionId: pos.id, price, time: timeMs, feePct: fee, slippagePct: slip, reason });
    if (!r.ok) return;
    acc = r.account;
    trades.push(r.trade);
    fills.push(r.fill);
    lastExit = timeMs;
    say(timeMs, pos.side === 'long' ? 'sell' : 'buy', `${pos.side === 'long' ? 'Sold' : 'Covered'} at ${r.trade.exitPrice.toFixed(2)} for ${r.trade.pnl >= 0 ? '+' : '−'}$${Math.abs(r.trade.pnl).toFixed(2)} (${r.trade.pnlPct.toFixed(2)}%). ${reason}.`);
  };

  const open = (side: Side, amount: number, price: number, timeMs: number, reason: string, stopPct: number, targetPct: number) => {
    const r = openPosition(acc, {
      symbol: 'BT',
      side,
      amount,
      price,
      time: timeMs,
      feePct: fee,
      slippagePct: slip,
      stopLossPct: stopPct,
      takeProfitPct: targetPct,
      by: 'bot',
      reason,
    });
    if (!r.ok) return;
    acc = r.account;
    fills.push(r.fill);
    entries.push(timeMs);
    say(timeMs, side === 'long' ? 'buy' : 'sell', `${side === 'long' ? 'Bought' : 'Shorted'} $${amount.toFixed(2)} at ${r.position.entryPrice.toFixed(2)}. ${reason}`);
  };

  let barIdx = Math.max(0, firstTradeBar);
  const firstBase = lowerBound(base, start);
  if (firstBase >= base.length || firstTradeBar >= bars.length) throw new Error('No candles in the test window');
  say(start * 1000, 'info', `Backtest started with $${startCash.toLocaleString()} on ${timeframe} candles.`);

  const ee = input.earlyExit;
  let eeIdx = ee ? lowerBound(ee.bars, start) : 0;

  let lastIdx = firstBase;
  for (let i = firstBase; i < base.length; i++) {
    const c = base[i];
    if (c.time >= end) break;
    lastIdx = i;
    const tMs = (c.time + 60) * 1000; // decisions happen as the minute completes
    minutes++;

    // 1. Stops and targets inside this minute. When both could have hit, assume the stop did (pessimistic).
    const pos = acc.positions[0];
    if (pos) {
      exposedMinutes++;
      const adverse = pos.side === 'long' ? c.low : c.high;
      const favourable = pos.side === 'long' ? c.high : c.low;
      const hitStop = pos.stopLoss !== null && protectiveExit(pos, adverse)?.level === pos.stopLoss;
      if (hitStop) {
        const gap = pos.side === 'long' ? Math.min(c.open, pos.stopLoss!) : Math.max(c.open, pos.stopLoss!);
        close(pos, gap, tMs, protectiveExit(pos, adverse)!.reason);
      } else {
        const tp = protectiveExit(pos, favourable);
        if (tp && pos.takeProfit !== null) {
          close(pos, pos.side === 'long' ? Math.max(c.open, pos.takeProfit) : Math.min(c.open, pos.takeProfit), tMs, tp.reason);
        } else if (st.trailingStop) {
          const t = trail(pos, favourable, pos.trailPct ?? st.stopLossPct);
          if (t) acc = { ...acc, positions: [{ ...pos, ...t }] };
        }
      }
    }

    // 1b. Time limit: close at this minute's close once the trade has been held long enough.
    const held = acc.positions[0];
    if (held && st.maxHoldMin && tMs - held.entryTime >= st.maxHoldMin * 60_000) close(held, c.close, tMs, `Held ${st.maxHoldMin} minutes`);

    // 2. Session loss / profit limits, marked to this minute's close.
    const eqNow = acc.cash + acc.positions.reduce((s, p) => s + positionValue(p, c.close), 0);
    peak = Math.max(peak, eqNow);
    maxDd = Math.max(maxDd, ((peak - eqNow) / peak) * 100);
    if (!stopped) {
      const pnl = eqNow - startCash;
      if (st.maxLoss > 0 && pnl <= -st.maxLoss) stopped = `Session loss limit of $${st.maxLoss} reached`;
      else if (st.profitTarget > 0 && pnl >= st.profitTarget) stopped = `Profit target of $${st.profitTarget} reached`;
      if (stopped) {
        if (acc.positions[0]) close(acc.positions[0], c.close, tMs, stopped);
        say(tMs, 'warn', `Bot stopped: ${stopped}.`);
      }
    }

    // 2b. Early exit when the faster chart turns against the open trade.
    while (ee && eeIdx < ee.bars.length && ee.bars[eeIdx].time + ee.seconds <= c.time + 60) {
      const p = acc.positions[0];
      if (p && !stopped) {
        const score = signalAt(ee.signals, eeIdx).score;
        if (p.side === 'long' ? score <= -ee.threshold : score >= ee.threshold) {
          close(p, ee.bars[eeIdx].close, (ee.bars[eeIdx].time + ee.seconds) * 1000, 'Shorter-term trend turned against the trade');
        }
      }
      eeIdx++;
    }

    // 3. Strategy candle closes → read the signal and decide.
    while (barIdx < bars.length && bars[barIdx].time + sec <= c.time + 60) {
      const b = bars[barIdx];
      if (b.time >= start && (barIdx % Math.max(1, Math.round(3600 / sec)) === 0 || barIdx === bars.length - 1)) {
        equity.push({ time: b.time + sec, value: acc.cash + acc.positions.reduce((s, p) => s + positionValue(p, b.close), 0) });
      }
      if (!stopped && b.time >= start) {
        const sig = signalAt(signals, barIdx);
        const p = acc.positions[0];
        const nowMs = (b.time + sec) * 1000;
        // Entries are in time order, so count back from the newest.
        let recentEntries = 0;
        for (let k = entries.length - 1; k >= 0 && entries[k] > nowMs - 60000; k--) recentEntries++;
        const d = decide({
          signal: sig,
          settings: st,
          position: p,
          cash: acc.cash,
          equity: acc.cash + (p ? positionValue(p, b.close) : 0),
          botInvested: p ? p.collateral : 0,
          recentEntries,
          msSinceExit: nowMs - lastExit,
        });
        if (d.kind === 'exit' && p) close(p, b.close, nowMs, d.reason);
        else if (d.kind === 'enter') open(d.side, d.amount, b.close, nowMs, d.reason, d.stopPct, d.targetPct);
      }
      barIdx++;
    }
  }

  // Close anything still open at the end so results are realised.
  const lastBase = base[lastIdx];
  if (acc.positions[0]) close(acc.positions[0], lastBase.close, (lastBase.time + 60) * 1000, 'End of test');
  const endEquity = acc.cash;
  equity.push({ time: lastBase.time + 60, value: endEquity });

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const startPrice = base[firstBase].open;

  return {
    bars: quiet ? [] : bars.slice(firstTradeBar, lowerBound(bars, end)),
    trades,
    fills,
    equity,
    log,
    stats: {
      startCash,
      endEquity,
      netPnl: endEquity - startCash,
      returnPct: ((endEquity - startCash) / startCash) * 100,
      buyHoldPct: ((lastBase.close - startPrice) / startPrice) * 100,
      startPrice,
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      best: trades.reduce((m, t) => Math.max(m, t.pnl), 0),
      worst: trades.reduce((m, t) => Math.min(m, t.pnl), 0),
      fees: trades.reduce((s, t) => s + t.fees, 0),
      maxDrawdownPct: maxDd,
      exposurePct: minutes ? (exposedMinutes / minutes) * 100 : 0,
      longs: trades.filter((t) => t.side === 'long').length,
      shorts: trades.filter((t) => t.side === 'short').length,
      stoppedEarly: stopped,
    },
  };
}

/** Index of the first candle at or after `time` (candles sorted by time). */
export function lowerBound(arr: Candle[], time: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
