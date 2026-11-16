import type { ChartCheck } from './lib/chartRules';
export type AssetClass = 'crypto' | 'stock';
export type Interval = '1s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h';
export type Side = 'long' | 'short';
export type Actor = 'bot' | 'manual';
export type Theme = 'dark' | 'light';

export interface Candle {
  /** Bar open time, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Market {
  /** Feed symbol, e.g. BTCUSDT or AAPL. */
  symbol: string;
  name: string;
  asset: AssetClass;
  /** TradingView symbol, e.g. BINANCE:BTCUSDT or NASDAQ:AAPL. */
  tv: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: number;
  /** Cash locked when the position was opened (its notional). */
  collateral: number;
  entryFee: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Best price seen since entry, used by the trailing stop. */
  peak: number;
  /** Trailing distance in percent, set at entry (ATR-based stops vary per trade). */
  trailPct?: number;
  openedBy: Actor;
  reason: string;
  /** The situation the trade was opened in, for the bot's lessons (src/trader/lessons.ts). */
  situation?: string;
  /** Opened during a Blitz session. */
  blitz?: boolean;
  /** Real trading only: where the order went and the stop-loss order Binance holds for it. */
  real?: RealPosition;
}

export interface RealPosition {
  env: 'testnet' | 'live';
  buyOrderId: number;
  /** The stop-loss order resting on Binance, if one is placed. */
  stopOrderId?: number;
  /**
   * Binance fill price ÷ chart price at the buy. Testnet prices differ from the real market the chart
   * shows, so the chart price is scaled by this to value the position. 1 for real money.
   */
  priceRatio: number;
}

export interface Trade {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  openedBy: Actor;
  entryReason: string;
  exitReason: string;
  /** The situation the trade was opened in, for the bot's lessons. */
  situation?: string;
  /** Opened during a Blitz session. */
  blitz?: boolean;
}

/** A single executed order, used for chart markers. */
export interface Fill {
  id: string;
  time: number;
  symbol: string;
  action: 'buy' | 'sell';
  kind: 'open' | 'close';
  qty: number;
  price: number;
  by: Actor;
}

export type LogLevel = 'buy' | 'sell' | 'think' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  time: number;
  level: LogLevel;
  symbol?: string;
  message: string;
}

export type StrategyId = 'smart' | 'ema' | 'rsi' | 'bollinger' | 'macd' | 'breakout' | 'pullback' | 'chart';
export type EntryTiming = 'close' | 'tick';

export interface BotSettings {
  symbols: string[];
  strategy: StrategyId;
  tradeAmount: number;
  budget: number;
  maxTradesPerMinute: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStop: boolean;
  /** Stop the bot when session loss reaches this many dollars. 0 = off. */
  maxLoss: number;
  /** Stop the bot when session profit reaches this many dollars. 0 = off. */
  profitTarget: number;
  minConfidence: number;
  entryTiming: EntryTiming;
  allowShort: boolean;
  feePct: number;
  slippagePct: number;
  cooldownSec: number;
  /** Close a trade after this many minutes if neither stop nor target was hit. 0 or unset = no limit. */
  maxHoldMin?: number;
  /** Re-read the chart on every live price and sell as soon as it turns, instead of waiting for the candle to close. */
  liveExits?: boolean;
  /** Your own stop loss in percent under the buy price, instead of the strategy's. */
  fixedStopPct?: number;
  /** Your own take profit in percent above the buy price, instead of the strategy's. */
  fixedTargetPct?: number;
  /** Smallest stop distance in percent; a closer ATR stop (and its target) is widened to it. */
  minStopPct?: number;
  /** Least to spend on one trade: a smaller risk-sized trade is raised to this. */
  minTradeAmount?: number;
  /** 'percent' uses stopLossPct/takeProfitPct; 'atr' sizes them from recent volatility. */
  stopMode: 'percent' | 'atr';
  stopAtr: number;
  /** Take profit as a multiple of ATR. 0 = off. */
  targetAtr: number;
  /** Only buy in an uptrend and only short in a downtrend. */
  trendFilter: boolean;
  /** Close when the signal turns against the position. Off lets stops and targets manage exits. */
  exitOnSignal: boolean;
  /** Skip trades whose stop distance is under 3× the round-trip cost of fees and slippage. */
  feeFilter: boolean;
  /** 'fixed' trades the amount per trade; 'risk' sizes each trade to lose riskPct of the account at its stop. */
  sizing: 'fixed' | 'risk';
  riskPct: number;
  /** 'signals' trades strategy signals with stops; 'trend' holds trend-following positions sized by volatility. */
  mode: 'signals' | 'trend';
  /** Trend mode: yearly swing to aim for, in percent. */
  trendTargetVol: number;
  /** Trend mode: never short. */
  trendLongOnly: boolean;
}

export interface Session {
  startTime: number;
}

export type FeedStatus = 'connecting' | 'live' | 'simulated' | 'waiting' | 'offline';

export interface Signal {
  /** -100 (strong sell) … +100 (strong buy). */
  score: number;
  reasons: string[];
  ready: boolean;
  /** Average true range as a percent of price. */
  atrPct?: number;
  /** 1 uptrend, -1 downtrend, 0 unclear (price vs 50 and 200 EMA). */
  trend?: -1 | 0 | 1;
  /** Chart reader only: the verdict and the checks behind it, shown instead of a score. */
  action?: 'buy' | 'sell' | 'hold';
  checks?: { entry: ChartCheck[]; exit: ChartCheck[] };
}
