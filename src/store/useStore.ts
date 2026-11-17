import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { BotSettings, Fill, Interval, LogEntry, LogLevel, Market, Position, Session, Signal, Theme, Trade } from '../types';
import type { BacktestTimeframe } from '../engine/backtest';
import { setMoneyDisplay, uid } from '../lib/format';

export const STARTING_CASH = 10_000;
/** Paper money for a rupee account. */
export const STARTING_INR = 100_000;
/** Used when the live rupee rate can't be fetched. */
export const FALLBACK_INR_RATE = 95;

/** Paper money: $10,000, ₹1,00,000 or an amount you choose; rupees are held as USDT at a rate fixed when chosen. */
export interface Account {
  currency: 'USD' | 'INR';
  /** Rupees per USDT; 1 for dollars. */
  rate: number;
  /** Starting paper money in the account's currency, if not the standard $10,000 or ₹1,00,000. */
  amount?: number;
}
const USD_ACCOUNT: Account = { currency: 'USD', rate: 1 };
/** Starting cash in USDT. */
export const startCash = (a: Account) => (a.amount && a.amount > 0 ? a.amount / a.rate : a.currency === 'INR' ? STARTING_INR / a.rate : STARTING_CASH);
/** The starting paper money as you chose it, e.g. "$150" or "₹1,00,000". */
export const startLabel = (a: Account) =>
  a.currency === 'INR' ? `₹${(a.amount ?? STARTING_INR).toLocaleString('en-IN')}` : `$${(a.amount ?? STARTING_CASH).toLocaleString('en-US')}`;
const MAX_LOGS = 800;
const MAX_HISTORY = 2000;
/** Hourly account snapshots kept for the paper-test chart (about 83 days). */
const MAX_SNAPSHOTS = 2000;

/** The original default settings. Research scripts and tests build on these. */
export const CLASSIC_SETTINGS: BotSettings = {
  symbols: ['BTCUSDT'],
  strategy: 'smart',
  tradeAmount: 500,
  budget: 5000,
  maxTradesPerMinute: 4,
  stopLossPct: 1,
  takeProfitPct: 2,
  trailingStop: true,
  maxLoss: 500,
  profitTarget: 0,
  minConfidence: 50,
  entryTiming: 'close',
  allowShort: false,
  feePct: 0.1,
  slippagePct: 0.02,
  cooldownSec: 10,
  stopMode: 'percent',
  stopAtr: 2.5,
  targetAtr: 0,
  trendFilter: false,
  exitOnSignal: true,
  feeFilter: false,
  sizing: 'fixed',
  riskPct: 1,
  mode: 'signals',
  trendTargetVol: 25,
  trendLongOnly: false,
};

/**
 * The best BTC settings from walk-forward research on 20 months of 1-minute prices: chosen on
 * Mar 2025 – Mar 2026, then checked unchanged on Apr – Oct 2026. Use with 4-hour candles.
 */
export const RECOMMENDED = {
  strategy: 'macd',
  minConfidence: 50,
  stopMode: 'atr',
  stopAtr: 2.5,
  targetAtr: 6,
  trailingStop: false,
  trendFilter: false,
  exitOnSignal: false,
  allowShort: true,
  feeFilter: true,
  entryTiming: 'close',
} satisfies Partial<BotSettings>;

/** The one setting this app trades: BTC/USDT, the tested settings, $10,000 per trade. */
export const SETTINGS: BotSettings = {
  ...CLASSIC_SETTINGS,
  ...RECOMMENDED,
  symbols: ['BTCUSDT'],
  tradeAmount: STARTING_CASH,
  budget: STARTING_CASH,
  maxLoss: 0,
  profitTarget: 0,
};
export const SYMBOL = 'BTCUSDT';
/** The tested mode decides on 4-hour candles, whatever the chart shows. */
export const BOT_INTERVAL = '4h' satisfies Interval;
export const MARKET: Market = { symbol: SYMBOL, name: 'Bitcoin', asset: 'crypto', tv: 'BINANCE:BTCUSDT' };

/**
 * Live mode: reads the 1-minute chart all the time instead of waiting for a long candle. It buys
 * when every check on the chart passes as a minute closes, and sells as soon as the chart turns
 * (checked on every price update), or at its stop. Buys only, as on Indian spot exchanges.
 * The checklist had no edge before fees on 20 months of 1-minute prices (scripts/live-mode-research.ts);
 * scripts/loss-research.ts found the rules and the 2.5 ATR stop that lost least while still trading
 * about once a day.
 */
export const LIVE_SETTINGS: BotSettings = {
  ...SETTINGS,
  strategy: 'chart',
  minConfidence: 50,
  exitOnSignal: true,
  liveExits: true,
  stopMode: 'atr',
  stopAtr: 2.5,
  targetAtr: 0,
  trailingStop: false,
  trendFilter: false,
  allowShort: false,
  feeFilter: false,
  cooldownSec: 15 * 60,
  maxHoldMin: 0,
};

/**
 * The trader: buys when 4-hour momentum (MACD) turns up and sells short when it turns down, with
 * a stop at 2.5× and a target at 6× the typical 4-hour move, both checked on every price update.
 * Each trade is sized so that hitting its stop loses riskPct of the account, fees included, so a
 * small account risks small amounts. No other filters. scripts/trader-report.ts has the results.
 */
export const TRADER_SETTINGS: BotSettings = {
  ...SETTINGS,
  feeFilter: false,
  sizing: 'risk',
  riskPct: 0.5,
  tradeAmount: Number.MAX_SAFE_INTEGER,
  budget: Number.MAX_SAFE_INTEGER,
};

export type BotMode = 'tested' | 'live';

export interface ModeSpec {
  id: BotMode;
  label: string;
  interval: Interval & BacktestTimeframe;
  barSec: number;
  /** "4-hour", "1-minute": for sentences about candles. */
  candle: string;
  settings: BotSettings;
  /** Logged when the bot starts. */
  summary: string;
  /** Rows for the strategy panel. */
  spec: [string, string][];
  results: string;
}

export const MODES: Record<BotMode, ModeSpec> = {
  tested: {
    id: 'tested',
    label: 'Trader · 4-hour momentum',
    interval: '4h',
    barSec: 14_400,
    candle: '4-hour',
    settings: TRADER_SETTINGS,
    summary: 'buys when 4-hour momentum turns up, sells short when it turns down, stop 2.5× and target 6× the typical 4-hour move, each trade sized so its stop loses your set % of the account',
    spec: [
      ['Buys when', 'Momentum (MACD) on 4-hour candles turns up, score +50 or more'],
      ['Sells short when', 'Momentum turns down, score −50 or less (paper only)'],
      ['When it decides', 'As each 4-hour candle closes: 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 UTC'],
      ['Watching', 'Stop and target checked on every price update, about every second'],
      ['Stop loss', '2.5× the typical 4-hour move (ATR)'],
      ['Take profit', '6× ATR'],
      ['Trade size', 'Sized so the stop loses at most your set % of the account, fees included'],
    ],
    results:
      'With at most 0.5% lost a trade, on Binance prices it made +9.0% from Mar 2025 to Mar 2026 and +2.6% from Apr to Oct 2026, never down more than 2.6%, and the worst trade lost $55 of $10,000. The 19 newest days (Oct 27 – Nov 14), which no research had seen, ended at −0.2%. It trades 2–4 times a month, so 15 days may bring only one or two trades.',
  },
  live: {
    id: 'live',
    label: 'Live · 1-minute',
    interval: '1m',
    barSec: 60,
    candle: '1-minute',
    settings: LIVE_SETTINGS,
    summary: 'reads the 1-minute chart, buys when every check passes (including steady, not choppy, and the 4-hour trend up), sells as soon as price falls clearly below its 1-hour average or at its stop (2.5× ATR), waits 15 minutes after a sale, buys only',
    spec: [
      ['How it decides', 'Reads the 1-minute chart on every price update. No points: a checklist'],
      ['Buys when', 'Every buy check is ✓ as a 1-minute candle closes, including steady (not choppy) and the 4-hour trend up'],
      ['Sells when', 'Price falls clearly below its 1-hour average (checked every second), or the stop is hit'],
      ['Trade size', 'The whole account, one position at a time'],
      ['Stop loss', '2.5× the average 1-minute candle (ATR) under the buy price'],
      ['Take profit', 'None: it rides the move until the chart turns'],
      ['Pace', 'Waits 15 minutes after a sale before buying again'],
      ['Shorting', 'Off: buys only, as on Indian spot exchanges'],
    ],
    results:
      'For watching the bot react to the chart in real time. On 20 months of real prices it trades about once a day and a typical 10-day test lost about 2% (worst 13%), down from 6% (worst 38%) before the choppy-market and 4-hour-trend checks. It broke even before fees, so fees are most of the loss. Expect small losses.',
  },
};

/** How often the bot thinks about buying: the candle size it decides on. */
export type Timeframe = '1m' | '15m' | '1h' | '4h';

export interface TimeframeSpec {
  id: Timeframe;
  /** "Every 15 minutes": for the Profile choice. */
  label: string;
  short: string;
  interval: Interval & BacktestTimeframe;
  barSec: number;
  /** "15-minute": for sentences about candles. */
  candle: string;
  /** Stops closer than this are widened (with their targets): smaller moves can't beat the fees. */
  minStopPct: number;
  /** Days of history the bot learns from when it starts. */
  historyDays: number;
  /** Test results on Binance prices (scripts/timeframe-research.ts), 0.5% at risk a trade. */
  results: string;
}

export const TIMEFRAMES: Record<Timeframe, TimeframeSpec> = {
  '1m': {
    id: '1m',
    label: 'Every minute',
    short: '1 min',
    interval: '1m',
    barSec: 60,
    candle: '1-minute',
    minStopPct: 3,
    historyDays: 10,
    results: 'Tested: +7.5% (Mar 2025 – Mar 2026), −2.0% (Apr – Oct 2026), about 6 trades a month. A 1-minute move is far smaller than the fees, so stops are kept at least 3% away; without that it lost everything.',
  },
  '15m': {
    id: '15m',
    label: 'Every 15 minutes',
    short: '15 min',
    interval: '15m',
    barSec: 900,
    candle: '15-minute',
    minStopPct: 3,
    historyDays: 180,
    results: 'Tested: −6.5% (Mar 2025 – Mar 2026), −2.0% (Apr – Oct 2026), about 7 trades a month, with stops at least 3% away. It lost in both periods.',
  },
  '1h': {
    id: '1h',
    label: 'Every hour',
    short: '1 hour',
    interval: '1h',
    barSec: 3600,
    candle: '1-hour',
    minStopPct: 3,
    historyDays: 730,
    results: 'Tested: +6.3% (Mar 2025 – Mar 2026), −2.3% (Apr – Oct 2026), about 5 trades a month, with stops at least 3% away.',
  },
  '4h': {
    id: '4h',
    label: 'Every 4 hours',
    short: '4 hours',
    interval: '4h',
    barSec: 14_400,
    candle: '4-hour',
    minStopPct: 0,
    historyDays: 730,
    results: 'Tested: +9.0% (Mar 2025 – Mar 2026), +2.6% (Apr – Oct 2026), about 3 trades a month. The best of the four in both periods.',
  },
};

/**
 * Blitz: quick trades on the 1-minute chart for at most 2 hours, once a day. It enters whenever the
 * chart leans one way and lets a winner run behind a stop that trails 0.5% under the best price
 * (over the best price for a short), instead of selling at a fixed target. No quick-trade rule
 * beat the fees in testing; letting winners run lost about a quarter as much as selling at a fixed
 * target (scripts/blitz-hold-research.ts). A session stops early once it has lost BLITZ_STOP_PCT
 * of the balance, and its open trade is closed when the 2 hours are up.
 */
export const BLITZ_MINUTES = 120;
export const BLITZ_STOP_PCT = 2;
export const BLITZ_RULES: Partial<BotSettings> = {
  strategy: 'smart',
  minConfidence: 30,
  stopMode: 'percent',
  stopLossPct: 0.5,
  takeProfitPct: 0,
  maxHoldMin: 0,
  exitOnSignal: false,
  trailingStop: true,
  feeFilter: false,
  trendFilter: false,
  cooldownSec: 60,
  maxTradesPerMinute: 1,
  riskPct: 0.25,
};

export interface BlitzSession {
  startedAt: number;
  endsAt: number;
  /** Account value when it started, for its result and its loss stop. */
  startEquity: number;
  /** Whether the bot was running before; if not, it stops again when Blitz ends. */
  wasRunning: boolean;
}

export type ChartView = 'bot' | 'tradingview';
export type AppView = 'live' | 'backtest' | 'profile';

export interface Toast {
  id: string;
  tone: 'good' | 'bad' | 'info';
  message: string;
}

/** The record of a paper-trading test, from the first start after a reset. */
export interface PaperTest {
  startedAt: number;
  startEquity: number;
  startPrice: number;
}

export interface Snapshot {
  time: number;
  equity: number;
  price: number;
}

/** Where orders go: practice money in the app, Binance's free test exchange, or a real Binance account. */
export type TradingMode = 'paper' | 'testnet' | 'live';

export type TaxSystem = 'none' | 'india' | 'flat';

/** What you control on the Profile screen. Amounts are in the account's currency. */
export interface Controls {
  /** How often the bot thinks about buying: the candle size it decides on. */
  timeframe: Timeframe;
  /** Let the neural network skip signals, once its skipped signals have clearly lost money. */
  brain: boolean;
  /** The most one trade may lose if its stop is hit, in % of the account, fees included. */
  riskPct: number;
  /** The most one trade may spend. null = no cap (paper only; real trading needs one). */
  maxSpend: number | null;
  /** The least to spend on one trade: smaller risk-sized trades are raised to it. null = no minimum. */
  minSpend: number | null;
  /** Blitz's own amounts per trade; null = the same as normal trades. */
  blitzMinSpend: number | null;
  blitzMaxSpend: number | null;
  /**
   * How Blitz buys and sells short: at the market price straight away, or with a waiting (limit)
   * order a little better than the price, which pays no slippage but may not fill.
   */
  blitzEntry: 'market' | 'limit';
  /** Binance's fee: 0.1% standard, or 0.075% when fees are paid in BNB. */
  feeLevel: 'standard' | 'bnb';
  /** New trades per day, counted from local midnight. null = no limit. */
  dailyTrades: number | null;
  /** Local hours when the bot may open trades: from (0–23) up to to (1–24); wraps past midnight if to <= from. null = any time. */
  hours: { from: number; to: number } | null;
  /** Close an open trade when your hours end, instead of leaving it to its stop and target. */
  closeAfterHours: boolean;
  /** Stop the bot once the test has lost this much. null = off. */
  lossLimit: number | null;
  /** Sell short when momentum turns down. Paper only: Binance spot can't short. */
  allowShort: boolean;
  /** Skip situations that keep losing, from the bot's lessons. Off by default: in tests it didn't help. */
  learnSkip: boolean;
  /** How profits are taxed, for the estimate on the Profile screen. */
  tax: TaxSystem;
  /** Tax rate for 'flat', in % of the total profit. */
  taxPct: number;
}
export const DEFAULT_CONTROLS: Controls = {
  timeframe: '4h',
  brain: true,
  riskPct: 0.5,
  maxSpend: null,
  minSpend: null,
  blitzMinSpend: null,
  blitzMaxSpend: null,
  blitzEntry: 'market',
  feeLevel: 'standard',
  dailyTrades: null,
  hours: null,
  closeAfterHours: false,
  lossLimit: null,
  allowShort: true,
  learnSkip: false,
  tax: 'india',
  taxPct: 30,
};

/** The bot's candle size, wording and spec rows for your chosen timeframe. */
export function botSpec(c: Pick<Controls, 'timeframe'>): ModeSpec {
  const t = TIMEFRAMES[c.timeframe] ?? TIMEFRAMES['4h'];
  const base = MODES.tested;
  const decides =
    t.id === '4h'
      ? 'As each 4-hour candle closes: 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 UTC'
      : t.id === '1h'
        ? 'As each hour closes'
        : t.id === '15m'
          ? 'Every 15 minutes, as each 15-minute candle closes'
          : 'Every minute, as each 1-minute candle closes';
  return {
    ...base,
    label: `Trader · ${t.short}`,
    interval: t.interval,
    barSec: t.barSec,
    candle: t.candle,
    summary: `buys when ${t.candle} momentum turns up, sells short when it turns down, stop 2.5× and target 6× the typical ${t.candle} move${t.minStopPct ? ` (stop at least ${t.minStopPct}% away)` : ''}, each trade sized so its stop loses your set % of the account`,
    spec: base.spec.map(([k, v]): [string, string] =>
      k === 'When it decides'
        ? [k, decides]
        : k === 'Buys when'
          ? [k, `Momentum (MACD) on ${t.candle} candles turns up, score +50 or more`]
          : k === 'Stop loss'
            ? [k, `2.5× the typical ${t.candle} move (ATR)${t.minStopPct ? `, at least ${t.minStopPct}% away` : ''}`]
            : k === 'Take profit'
              ? [k, t.minStopPct ? '6× ATR, widened with the stop' : '6× ATR']
              : [k, v],
    ),
    results: t.results,
  };
}

/** Blitz's quick-trade settings with your amounts and shorting applied (your risk setting is capped at 0.25%). */
export function blitzSettings(account: Account, controls: Controls = DEFAULT_CONTROLS, trading: TradingMode = 'paper'): BotSettings {
  const base = settingsFor(account, { ...controls, minSpend: controls.blitzMinSpend ?? controls.minSpend, maxSpend: controls.blitzMaxSpend ?? controls.maxSpend }, trading);
  return { ...base, ...BLITZ_RULES, riskPct: Math.min(controls.riskPct, BLITZ_RULES.riskPct!), minStopPct: undefined };
}

/** The trader's settings with your controls applied. */
export function settingsFor(account: Account, controls: Controls = DEFAULT_CONTROLS, trading: TradingMode = 'paper'): BotSettings {
  const cap = controls.maxSpend ? controls.maxSpend / account.rate : null;
  const real = trading !== 'paper';
  return {
    ...TRADER_SETTINGS,
    riskPct: controls.riskPct,
    feePct: controls.feeLevel === 'bnb' ? 0.075 : 0.1,
    minStopPct: TIMEFRAMES[controls.timeframe].minStopPct || undefined,
    minTradeAmount: controls.minSpend ? controls.minSpend / account.rate : undefined,
    // A normal Binance account can only buy and sell what it holds, so real trading never shorts.
    allowShort: real ? false : controls.allowShort,
    tradeAmount: cap ?? (real ? 0 : Number.MAX_SAFE_INTEGER),
    maxLoss: controls.lossLimit ? controls.lossLimit / account.rate : 0,
  };
}

const hourText = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
export const describeHours = (h: Controls['hours']) => (h ? `${hourText(h.from)}–${hourText(h.to)}` : 'any time');

/** True when local time `now` is inside your trading hours. */
export function inHours(h: Controls['hours'], now = Date.now()): boolean {
  if (!h) return true;
  const d = new Date(now);
  const t = d.getHours() + d.getMinutes() / 60;
  return h.from < h.to ? t >= h.from && t < h.to : t >= h.from || t < h.to;
}

/** Local midnight of the day containing `now`. */
export const dayStart = (now = Date.now()) => new Date(now).setHours(0, 0, 0, 0);

/** Your controls in one sentence, for the log. */
export function describeControls(c: Controls, account: Account, trading: TradingMode): string {
  const cur = account.currency === 'INR' ? '₹' : '$';
  const amt = (n: number) => `${cur}${n.toLocaleString(account.currency === 'INR' ? 'en-IN' : 'en-US')}`;
  return [
    `decides ${TIMEFRAMES[c.timeframe].label.toLowerCase()}`,
    `at most ${c.riskPct}% of the account lost a trade`,
    c.minSpend && c.maxSpend
      ? `${amt(c.minSpend)}–${amt(c.maxSpend)} a trade`
      : c.maxSpend
        ? `at most ${amt(c.maxSpend)} spent a trade`
        : c.minSpend
          ? `at least ${amt(c.minSpend)} a trade`
          : '',
    c.dailyTrades ? `at most ${c.dailyTrades} trade${c.dailyTrades > 1 ? 's' : ''} a day` : '',
    c.hours ? `trades only ${describeHours(c.hours)}${c.closeAfterHours ? ', closing after hours' : ''}` : '',
    trading === 'paper' ? (c.allowShort ? 'buys and shorts' : 'buys only') : 'buys only',
    c.brain ? 'neural network may skip trades once trusted' : 'neural network only watches',
    c.lossLimit ? `loss limit ${amt(c.lossLimit)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Checks controls and returns a plain-language problem, or null. */
export function checkControls(c: Controls, trading: TradingMode): string | null {
  if (!(c.timeframe in TIMEFRAMES)) return 'Choose how often the bot decides.';
  if (!(c.riskPct >= 0.1 && c.riskPct <= 10)) return 'The most a trade can lose must be between 0.1% and 10% of the account.';
  if (c.maxSpend !== null && !(c.maxSpend > 0)) return 'The most to spend on a trade must be above 0.';
  if (trading !== 'paper' && !c.maxSpend) return 'Real trading needs a most-to-spend amount per trade.';
  if (c.minSpend !== null && !(c.minSpend > 0)) return 'The least to spend on a trade must be above 0.';
  if (c.minSpend !== null && c.maxSpend !== null && c.minSpend > c.maxSpend) return 'The least to spend on a trade can’t be more than the most.';
  if (c.blitzMinSpend !== null && !(c.blitzMinSpend > 0)) return 'The least Blitz trade must be above 0.';
  if (c.blitzMaxSpend !== null && !(c.blitzMaxSpend > 0)) return 'The most Blitz trade must be above 0.';
  if (c.blitzMinSpend !== null && c.blitzMaxSpend !== null && c.blitzMinSpend > c.blitzMaxSpend) return 'The least Blitz trade can’t be more than the most.';
  if (c.dailyTrades !== null && !(Number.isInteger(c.dailyTrades) && c.dailyTrades >= 1 && c.dailyTrades <= 100)) return 'Trades a day must be a whole number from 1 to 100.';
  if (c.hours && !(Number.isInteger(c.hours.from) && Number.isInteger(c.hours.to) && c.hours.from >= 0 && c.hours.from <= 23 && c.hours.to >= 1 && c.hours.to <= 24 && c.hours.from !== c.hours.to % 24))
    return 'Choose a start and an end hour that differ.';
  if (c.lossLimit !== null && !(c.lossLimit > 0)) return 'The loss limit must be above 0.';
  if (c.tax === 'flat' && !(c.taxPct >= 0 && c.taxPct <= 60)) return 'The tax rate must be between 0% and 60%.';
  return null;
}

export interface AppState {
  theme: Theme;
  interval: Interval;
  chartView: ChartView;
  view: AppView;
  settings: BotSettings;
  /** Which strategy the bot trades; the settings follow it. */
  mode: BotMode;
  account: Account;
  controls: Controls;
  tradingMode: TradingMode;

  running: boolean;
  session: Session | null;
  /** The Blitz session running now, if any. */
  blitz: BlitzSession | null;
  /** Local midnight of the day Blitz was last used: once a day. */
  blitzUsedOn: number;
  test: PaperTest | null;
  cash: number;
  positions: Position[];
  trades: Trade[];
  fills: Fill[];
  logs: LogEntry[];
  snapshots: Snapshot[];
  /** Open time of the last 4-hour candle the bot made a decision on. */
  lastDecisionBar: number;
  /** Last time a live price was processed; used to catch up after the app was closed or offline. */
  lastSeen: number;
  /** Total time without live prices while the bot was running. */
  offlineMs: number;

  /** Latest signal — live only, never saved. */
  signals: Record<string, Signal & { time: number }>;
  /** Times of recent bot orders, for the per-minute limit. */
  orderTimes: number[];
  toasts: Toast[];

  setTheme(t: Theme): void;
  setInterval(iv: Interval): void;
  setChartView(v: ChartView): void;
  setView(v: AppView): void;
  /** Chooses dollars or rupees; only before a test has started. Returns an error or null. */
  setAccount(a: Account): string | null;
  /** Saves your trade controls; they apply from the next trade. Returns an error or null. */
  setControls(c: Controls): string | null;
  /** Paper, Binance Testnet or real money; only before a test has started. Returns an error or null. */
  setTradingMode(m: TradingMode): string | null;
  log(level: LogLevel, message: string, symbol?: string): void;
  clearLogs(): void;
  toast(tone: Toast['tone'], message: string): void;
  dismissToast(id: string): void;
  /** Starts over: erases the test. Returns an error (for example a real position is still open) or null. */
  resetAccount(): string | null;
}

/** localStorage writes are batched so frequent log lines don't block the main thread. */
const pending = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const flush = () => {
  flushTimer = undefined;
  for (const [k, v] of pending) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage full or blocked: the app keeps working in memory */
    }
  }
  pending.clear();
};
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}
const batchedStorage: StateStorage = {
  getItem: (k) => {
    try {
      return pending.get(k) ?? localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    pending.set(k, v);
    flushTimer ??= setTimeout(flush, 800);
  },
  removeItem: (k) => {
    pending.delete(k);
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const systemTheme = (): Theme =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      theme: systemTheme(),
      interval: BOT_INTERVAL,
      chartView: 'bot',
      view: 'live',
      settings: settingsFor(USD_ACCOUNT),
      mode: 'tested',
      account: USD_ACCOUNT,
      controls: DEFAULT_CONTROLS,
      tradingMode: 'paper',

      running: false,
      session: null,
      blitz: null,
      blitzUsedOn: 0,
      test: null,
      cash: STARTING_CASH,
      positions: [],
      trades: [],
      fills: [],
      logs: [],
      snapshots: [],
      lastDecisionBar: 0,
      lastSeen: 0,
      offlineMs: 0,
      signals: {},
      orderTimes: [],
      toasts: [],

      setTheme: (theme) => {
        // Set synchronously so charts read the new colour tokens in their effects.
        document.documentElement.dataset.theme = theme;
        set({ theme });
      },
      setInterval: (interval) => set({ interval }),
      setChartView: (chartView) => set({ chartView }),
      setView: (view) => set({ view }),
      setAccount: (account) => {
        const s = get();
        if (s.test || s.positions.length || s.trades.length) return 'To change the paper money, start over first (the ↻ button at the top right).';
        if (s.tradingMode !== 'paper') return 'Real trading uses the USDT in your Binance account.';
        setMoneyDisplay(account.currency, account.rate);
        set({ account, cash: startCash(account), settings: settingsFor(account, s.controls, s.tradingMode) });
        get().log(
          'info',
          account.currency === 'INR'
            ? `Paper money set to ${startLabel(account)}, held as ${startCash(account).toFixed(2)} USDT at ₹${account.rate.toFixed(2)} per USDT.`
            : `Paper money set to ${startLabel(account)}.`,
        );
        return null;
      },
      setControls: (controls) => {
        const s = get();
        const problem = checkControls(controls, s.tradingMode);
        if (problem) return problem;
        set({
          controls,
          settings: s.blitz ? blitzSettings(s.account, controls, s.tradingMode) : settingsFor(s.account, controls, s.tradingMode),
          // The chart follows the candles the bot decides on.
          ...(controls.timeframe !== s.controls.timeframe ? { interval: TIMEFRAMES[controls.timeframe].interval } : {}),
        });
        const trading = (c: Controls) => JSON.stringify({ ...c, tax: 0, taxPct: 0 });
        if (trading(controls) !== trading(s.controls)) get().log('info', `Settings saved: ${describeControls(controls, s.account, s.tradingMode)}. They apply from the next trade.`);
        return null;
      },
      setTradingMode: (tradingMode) => {
        const s = get();
        if (tradingMode === s.tradingMode) return null;
        if (s.test || s.positions.length || s.trades.length) return 'To switch between paper and real trading, start over first (the ↻ button at the top right).';
        const real = tradingMode !== 'paper';
        const problem = real ? checkControls(s.controls, tradingMode) : null;
        if (problem) return problem;
        // Real trading counts in the USDT on Binance; its balance arrives from the local server.
        const account = real ? USD_ACCOUNT : s.account;
        setMoneyDisplay(account.currency, account.rate);
        set({ tradingMode, account, cash: real ? 0 : startCash(account), settings: settingsFor(account, s.controls, tradingMode) });
        get().log('info', tradingMode === 'paper' ? 'Switched to paper trading.' : `Switched to ${tradingMode === 'live' ? 'REAL MONEY' : 'Binance Testnet'} trading.`);
        return null;
      },
      log: (level, message, symbol) =>
        set((s) => {
          const logs = [{ id: uid(), time: Date.now(), level, message, symbol }, ...s.logs];
          if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
          return { logs };
        }),
      clearLogs: () => set({ logs: [] }),
      toast: (tone, message) => {
        const id = uid();
        set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, message }] }));
        setTimeout(() => get().dismissToast(id), 6000);
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      resetAccount: () => {
        const s = get();
        if (s.positions.some((p) => p.real)) return 'Sell the BTC the bot bought on Binance first (Positions tab), then start over.';
        set({
          running: false,
          session: null,
          blitz: null,
          test: null,
          cash: s.tradingMode === 'paper' ? startCash(s.account) : s.cash,
          positions: [],
          trades: [],
          fills: [],
          snapshots: [],
          lastDecisionBar: 0,
          lastSeen: 0,
          offlineMs: 0,
          logs: [
            {
              id: uid(),
              time: Date.now(),
              level: 'info',
              message:
                s.tradingMode === 'paper'
                  ? `Account reset to ${startLabel(s.account)} paper money.`
                  : 'Test erased. Your Binance balances are unchanged.',
            },
          ],
          orderTimes: [],
          signals: {},
        });
        return null;
      },
    }),
    {
      // A new key: the BTC edition starts fresh instead of inheriting multi-market settings.
      name: 'crdtrade-btc',
      version: 1,
      storage: createJSONStorage(() => batchedStorage),
      partialize: (s) => ({
        theme: s.theme,
        interval: s.interval,
        chartView: s.chartView,
        view: s.view,
        mode: s.mode,
        account: s.account,
        controls: s.controls,
        tradingMode: s.tradingMode,
        running: s.running,
        session: s.session,
        blitz: s.blitz,
        blitzUsedOn: s.blitzUsedOn,
        test: s.test,
        cash: s.cash,
        positions: s.positions,
        trades: s.trades.slice(-MAX_HISTORY),
        fills: s.fills.slice(-MAX_HISTORY),
        logs: s.logs.slice(0, 400),
        snapshots: s.snapshots.slice(-MAX_SNAPSHOTS),
        lastDecisionBar: s.lastDecisionBar,
        lastSeen: s.lastSeen,
        offlineMs: s.offlineMs,
      }),
      // Settings are fixed in code per mode and never loaded from storage.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        // One trader now: the old Tested and Live modes both become it.
        const mode: BotMode = 'tested';
        const okAmount = (n: unknown) => typeof n === 'number' && n >= 10 && n <= 100_000_000;
        const account: Account =
          p.account?.currency === 'INR' && p.account.rate > 0
            ? { currency: 'INR', rate: p.account.rate, ...(okAmount(p.account.amount) ? { amount: p.account.amount } : {}) }
            : { ...USD_ACCOUNT, ...(okAmount(p.account?.amount) ? { amount: p.account!.amount } : {}) };
        const tradingMode: TradingMode = p.tradingMode === 'testnet' || p.tradingMode === 'live' ? p.tradingMode : 'paper';
        // Older saves had an amount per trade; for real trading it becomes the most to spend.
        const old = (p.controls ?? {}) as Partial<Controls> & { tradeAmount?: number | null };
        const merged: Controls = { ...DEFAULT_CONTROLS, ...old, maxSpend: old.maxSpend ?? old.tradeAmount ?? null };
        delete (merged as { tradeAmount?: unknown }).tradeAmount;
        for (const k of ['stopLossPct', 'takeProfitPct']) delete (merged as unknown as Record<string, unknown>)[k];
        const controls = checkControls(merged, tradingMode) ? { ...DEFAULT_CONTROLS, maxSpend: merged.maxSpend } : merged;
        const blitz = p.blitz && p.blitz.endsAt > 0 ? p.blitz : null;
        return {
          ...current,
          ...p,
          mode,
          blitz,
          interval: p.interval ?? BOT_INTERVAL,
          account,
          controls,
          tradingMode,
          settings: blitz ? blitzSettings(account, controls, tradingMode) : settingsFor(account, controls, tradingMode),
        };
      },
    },
  ),
);

export const MAX_FILLS = MAX_HISTORY;
export const MAX_SNAPSHOT_COUNT = MAX_SNAPSHOTS;

// Show amounts in the account's currency from the first render on.
setMoneyDisplay(useStore.getState().account.currency, useStore.getState().account.rate);
