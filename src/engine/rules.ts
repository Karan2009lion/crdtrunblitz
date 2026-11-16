import type { BotSettings, Position, Side, Signal } from '../types';

/**
 * The bot's trading rules as a pure function, shared by the live bot and the backtester
 * so a backtest makes exactly the decisions the live bot would.
 */

export interface DecisionInput {
  signal: Signal;
  settings: BotSettings;
  /** The bot's open position in this market, if any. */
  position?: Position;
  cash: number;
  /** Account value, used to size trades by risk. Defaults to cash. */
  equity?: number;
  /** Cash the bot already has tied up in positions. */
  botInvested: number;
  /** Bot entries in the last 60 seconds. */
  recentEntries: number;
  /** Time since the bot last closed a position in this market. */
  msSinceExit: number;
}

export type BlockReason = 'cooldown' | 'rate' | 'budget' | 'trend' | 'fees';

export type Decision =
  | { kind: 'warmup' }
  | { kind: 'idle'; side: Side | null }
  | { kind: 'hold' }
  | { kind: 'exit'; reason: string }
  | { kind: 'blocked'; side: Side; why: BlockReason; waitMs?: number }
  | { kind: 'enter'; side: Side; amount: number; reason: string; stopPct: number; targetPct: number };

export const fmtScore = (s: number) => (s > 0 ? `+${s}` : `${s}`);

/** A position is closed when the signal swings this far against it. */
export const exitThreshold = (minConfidence: number) => Math.max(10, minConfidence / 2);

/** Fees and slippage for a full round trip, in percent of the position. */
export const roundTripCostPct = (st: BotSettings) => 2 * (st.feePct + st.slippagePct);

/** Stop and target distances (percent of price) for a new trade. */
export function exitLevels(st: BotSettings, atrPct: number | undefined): { stopPct: number; targetPct: number } {
  const auto =
    st.stopMode === 'atr' && atrPct && atrPct > 0
      ? { stopPct: st.stopAtr * atrPct, targetPct: st.targetAtr > 0 ? st.targetAtr * atrPct : 0 }
      : { stopPct: st.stopLossPct, targetPct: st.takeProfitPct };
  // On short candles the typical move is smaller than the fees, so stops have a floor; the target
  // widens by the same factor to keep the reward the same multiple of the risk.
  if (st.minStopPct && auto.stopPct > 0 && auto.stopPct < st.minStopPct) {
    const k = st.minStopPct / auto.stopPct;
    auto.stopPct *= k;
    auto.targetPct *= k;
  }
  // Your own stop or target from the Profile screen replaces the strategy's.
  return { stopPct: st.fixedStopPct || auto.stopPct, targetPct: st.fixedTargetPct || auto.targetPct };
}

export function decide({ signal: sig, settings: st, position, cash, equity, botInvested, recentEntries, msSinceExit }: DecisionInput): Decision {
  if (!sig.ready) return { kind: 'warmup' };
  const why = sig.reasons.slice(0, 3).join('; ');
  const exitAt = exitThreshold(st.minConfidence);

  if (position) {
    // The chart reader gives a verdict, not a score: sell when the chart turns.
    if (st.exitOnSignal && sig.action) return sig.action === 'sell' ? { kind: 'exit', reason: why ? `Chart turned: ${why.toLowerCase()}` : 'Chart turned' } : { kind: 'hold' };
    if (st.exitOnSignal) {
      if (position.side === 'long' && sig.score <= -exitAt) return { kind: 'exit', reason: `Signal turned bearish (${fmtScore(sig.score)}): ${why}` };
      if (position.side === 'short' && sig.score >= exitAt) return { kind: 'exit', reason: `Signal turned bullish (${fmtScore(sig.score)}): ${why}` };
    } else if (st.trendFilter && sig.trend && sig.trend === (position.side === 'long' ? -1 : 1)) {
      // Without signal exits, still get out once the trend has clearly flipped.
      return { kind: 'exit', reason: `Trend turned ${sig.trend === 1 ? 'up' : 'down'}` };
    }
    return { kind: 'hold' };
  }

  const wants: Side | null = sig.score >= st.minConfidence ? 'long' : sig.score <= -st.minConfidence ? 'short' : null;
  if (!wants || (wants === 'short' && !st.allowShort)) return { kind: 'idle', side: wants };

  if (st.trendFilter && sig.trend !== (wants === 'long' ? 1 : -1)) return { kind: 'blocked', side: wants, why: 'trend' };
  const { stopPct, targetPct } = exitLevels(st, sig.atrPct);
  if (st.feeFilter && stopPct > 0 && stopPct < 3 * roundTripCostPct(st)) return { kind: 'blocked', side: wants, why: 'fees' };

  if (msSinceExit < st.cooldownSec * 1000) return { kind: 'blocked', side: wants, why: 'cooldown', waitMs: st.cooldownSec * 1000 - msSinceExit };
  if (recentEntries >= st.maxTradesPerMinute) return { kind: 'blocked', side: wants, why: 'rate' };

  // Risk sizing: lose about riskPct of the account if the stop is hit, fees and slippage included.
  const sized = st.sizing === 'risk' && stopPct > 0 ? ((equity ?? cash) * st.riskPct) / (stopPct + roundTripCostPct(st)) : st.tradeAmount;
  // Never more than the amount per trade or the budget, and leave room for the fee so a full-budget trade still fills.
  const room = Math.min(st.tradeAmount, st.budget - botInvested, cash / (1 + st.feePct / 100));
  // Your least per trade raises a smaller risk-sized trade, as far as the cash allows.
  const amount = Math.min(Math.max(sized, st.minTradeAmount ?? 0), room);
  // Risk-sized trades have no minimum beyond $1 (or yours): a small account makes small trades.
  const minimum = st.sizing === 'risk' ? Math.max(1, st.minTradeAmount ?? 0) : st.tradeAmount * 0.25;
  if (amount < minimum || amount < 1) return { kind: 'blocked', side: wants, why: 'budget' };

  const trendNote = st.trendFilter ? ` With the ${wants === 'long' ? 'up' : 'down'}trend.` : '';
  return {
    kind: 'enter',
    side: wants,
    amount: Math.floor(amount * 100) / 100,
    reason: sig.action ? `Every chart check passed${sig.checks ? `: ${sig.checks.entry.map((c) => c.label.toLowerCase()).join(', ')}` : ''}.` : `Score ${fmtScore(sig.score)}: ${why}.${trendNote}`,
    stopPct,
    targetPct,
  };
}
