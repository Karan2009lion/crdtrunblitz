import type { Candle, Position, Side, Signal } from '../types';
import { botHub, hub } from '../market/hub';
import { evaluate } from '../lib/strategies';
import { clock, duration, money, price as fmtPrice, signedMoney } from '../lib/format';
import { closePosition, markPrice, openPosition, positionValue, protectiveExit, trail, unrealized } from './broker';
import { decide as decideTrade, fmtScore } from './rules';
import { fetchBinanceKlines } from '../market/history';
import { keepAwake } from '../lib/wakeLock';
import { BLITZ_MINUTES, BLITZ_STOP_PCT, MARKET, MAX_FILLS, MAX_SNAPSHOT_COUNT, SYMBOL, TIMEFRAMES, blitzSettings, botSpec, dayStart, describeControls, describeHours, inHours, settingsFor, useStore, type ModeSpec } from '../store/useStore';
import { BRAIN_WARMUP, brainView, inputsNow, trusted, wouldSkip } from '../trader/brain';
import { describeSituation, lessonVerdict, type Situation } from '../trader/lessons';
import { ALGO_LABEL, algoStop, algoTrail, algoWant, readAlgoChart, type BlitzAlgo, type Want } from '../trader/blitzAlgos';
import { refreshLessons, situationNow, useLessons } from '../trader/useLessons';
import { STOP_BACKUP_GAP, checkRealStops, closeReal, openReal, realBusy, realBuying, realLastExit, syncRealCash } from './realOrders';
import { refreshReal, useReal } from '../real/useReal';

const get = useStore.getState;
const set = useStore.setState;
const NAME = 'BTC/USDT';
/** Blitz trades the 1-minute chart, whatever your chosen timeframe. */
const BLITZ_SPEC: ModeSpec = {
  ...botSpec({ timeframe: '1m' }),
  label: 'Blitz · 1 min',
  summary: 'Blitz: quick trades on the 1-minute chart for up to 2 hours',
};
/** The active strategy: candle size, settings and wording, for your chosen timeframe (or Blitz). */
const mode = () => (get().blitz ? BLITZ_SPEC : botSpec(get().controls));
/** A gap between live prices longer than this counts as time offline. */
const OFFLINE_MS = 2 * 60_000;

/* Memory that doesn't need saving. */
let lastDisplay = 0;
let lastExit = 0;
let lastTick = 0;
let lastSeenSaved = 0;
let catchingUp = false;
const lastThought = { key: '', time: 0 };
/** A signal that came outside your trading hours or over the daily limit: the 4-hour candle it is waiting on. */
let waitingFor = 0;
/** Blitz's waiting (limit) order, if one is out: fills when the price reaches it, or is cancelled. */
let pendingLimit: { side: Side; amount: number; limit: number; expires: number; reason: string; levels: { stopPct: number; targetPct: number } } | null = null;
/** How long a Blitz limit order waits, and how far under the price it sits (in typical 1-minute moves). */
const LIMIT_WAIT_MS = 3 * 60_000;
const LIMIT_OFFSET_ATR = 0.25;
let lastRetry = 0;
let lastHoursClose = 0;
const lastBlocked = new Map<string, number>();

const currentPrice = () => botHub.price(SYMBOL) ?? hub.price(SYMBOL);
export const livePrice = currentPrice;

export function accountValue(price = currentPrice()): number {
  const s = get();
  return s.cash + s.positions.reduce((sum, p) => sum + positionValue(p, price ?? p.entryPrice), 0);
}

/** Close time of the strategy candle that is forming now. */
export function nextDecisionTime(now = Date.now()) {
  const bar = mode().barSec * 1000;
  return Math.floor(now / bar) * bar + bar;
}

/** Time limit on a trade, in ms; 0 = none. */
const maxHoldMs = () => (get().settings.maxHoldMin ?? 0) * 60_000;

/* ------------------------------------------------------------------ orders */

function applyOpen(
  side: Side,
  amount: number,
  reason: string,
  levels: { stopPct: number; targetPct: number; situation?: string; blitz?: boolean },
  /** A waiting (limit) order that filled: its price, and no slippage. */
  at?: { price: number },
) {
  const s = get();
  if (s.tradingMode !== 'paper') {
    if (side === 'long' && !realBuying()) void openReal(amount, reason, levels, currentPrice() ?? 0);
    return;
  }
  const res = openPosition(
    { cash: s.cash, positions: s.positions },
    {
      symbol: SYMBOL,
      side,
      amount,
      price: at?.price ?? currentPrice() ?? 0,
      time: Date.now(),
      feePct: s.settings.feePct,
      slippagePct: at ? 0 : s.settings.slippagePct,
      stopLossPct: levels.stopPct,
      takeProfitPct: levels.targetPct,
      by: 'bot',
      reason,
      situation: levels.situation,
      blitz: levels.blitz,
    },
  );
  if (!res.ok) return void s.log('warn', `Skipped ${side === 'long' ? 'buy' : 'short'}: ${res.error}`, SYMBOL);
  const p = res.position;
  set({
    cash: res.account.cash,
    positions: res.account.positions,
    fills: [...s.fills, res.fill].slice(-MAX_FILLS),
    orderTimes: [...s.orderTimes.filter((t) => t > Date.now() - 60000), Date.now()],
  });
  const levelText = [p.stopLoss ? `stop ${fmtPrice(p.stopLoss)}` : '', p.takeProfit ? `target ${fmtPrice(p.takeProfit)}` : ''].filter(Boolean).join(', ');
  get().log(side === 'long' ? 'buy' : 'sell', `${levels.blitz ? 'Blitz: ' : ''}${side === 'long' ? 'Bought' : 'Shorted'} ${money(amount)} of ${NAME} at ${fmtPrice(p.entryPrice)} (${levelText}). ${reason}`, SYMBOL);
  get().toast('info', `${side === 'long' ? 'Bought' : 'Shorted'} BTC at ${fmtPrice(p.entryPrice)}`);
}

/** Closes a position at the live price, or at a given price and time when catching up. */
export function closeById(positionId: string, reason: string, at?: { price: number; time: number }): boolean {
  const s = get();
  const pos = s.positions.find((p) => p.id === positionId);
  if (!pos) return false;
  if (pos.real) {
    void closeReal(pos.id, reason);
    return true;
  }
  const res = closePosition(
    { cash: s.cash, positions: s.positions },
    { positionId, price: at?.price ?? currentPrice() ?? 0, time: at?.time ?? Date.now(), feePct: s.settings.feePct, slippagePct: s.settings.slippagePct, reason },
  );
  if (!res.ok) {
    s.toast('bad', res.error);
    return false;
  }
  const t = res.trade;
  lastExit = Date.now();
  set({
    cash: res.account.cash,
    positions: res.account.positions,
    trades: [...s.trades, t].slice(-MAX_FILLS),
    fills: [...s.fills, res.fill].slice(-MAX_FILLS),
  });
  get().log(
    t.side === 'long' ? 'sell' : 'buy',
    `${t.side === 'long' ? 'Sold' : 'Covered'} ${NAME} at ${fmtPrice(t.exitPrice)} for ${signedMoney(t.pnl)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%). ${reason}.`,
    SYMBOL,
  );
  get().toast(t.pnl >= 0 ? 'good' : 'bad', `BTC position closed ${signedMoney(t.pnl)}: ${reason.toLowerCase()}`);
  return true;
}

export function closeAll(filter: (p: Position) => boolean = () => true, reason = 'Closed manually') {
  for (const p of get().positions.filter(filter)) closeById(p.id, reason);
}

/* -------------------------------------------------------------- start, stop */

export function startBot(): string | null {
  const s = get();
  const px = currentPrice();
  if (!px) return 'Waiting for the first live BTC price. Check your internet connection.';
  if (s.tradingMode !== 'paper') {
    const r = useReal.getState();
    const name = s.tradingMode === 'live' ? 'real-money' : 'Testnet';
    if (r.state !== 'connected' || r.environment !== s.tradingMode) return `Connect your ${name} Binance API key on the Profile screen first.`;
    if (!s.settings.tradeAmount) return 'Set an amount per trade on the Profile screen first.';
    if (!(s.cash >= 5)) return 'Your Binance account needs at least 5 USDT free to trade.';
  }
  const now = Date.now();
  set({
    running: true,
    session: { startTime: now },
    test: s.test ?? { startedAt: now, startEquity: accountValue(px), startPrice: px },
    // Act on the next candle close, not on a signal that is already hours old.
    lastDecisionBar: Math.max(s.lastDecisionBar, nextDecisionTime(now) / 1000 - 2 * mode().barSec),
    lastSeen: now,
  });
  lastTick = now;
  waitingFor = 0;
  keepAwake(true);
  get().log(
    'info',
    `Bot started on ${NAME}${s.tradingMode === 'live' ? ' with REAL MONEY' : s.tradingMode === 'testnet' ? ' on Binance Testnet' : ''}: ${mode().summary}. Your settings: ${describeControls(s.controls, s.account, s.tradingMode)}. Next decision at ${clock(nextDecisionTime(now), false)} when the current ${mode().candle} candle closes.`,
  );
  snapshot(now, px, true);
  return null;
}

export function stopBot(reason = 'Bot stopped.') {
  if (!get().running) return;
  set({ running: false });
  keepAwake(false);
  const open = get().positions.length;
  get().log('info', `${reason}${open ? ' The open position stays protected by its stop loss and take profit.' : ''}`);
}

/* ------------------------------------------------------------------ Blitz */

/**
 * Starts a Blitz session: quick trades on the 1-minute chart for up to 2 hours, once a day.
 * `closeOpen` first closes an open trade at the market price.
 */
export function startBlitz(closeOpen = false): string | null {
  if (closeOpen && get().positions[0] && !get().positions[0].real && !get().blitz && get().blitzUsedOn !== dayStart(Date.now())) {
    closeById(get().positions[0].id, 'Closed to start Blitz');
  }
  const s = get();
  const now = Date.now();
  const px = currentPrice();
  if (s.blitz) return 'Blitz is already on.';
  if (s.tradingMode !== 'paper') return 'Blitz is for paper trading only.';
  if (s.blitzUsedOn === dayStart(now)) return 'Blitz was already used today. It can be used again from midnight.';
  if (s.positions.length) return 'Blitz starts with no open trade. Close the open trade first, or wait for it to finish.';
  if (!px) return 'Waiting for the first live BTC price. Check your internet connection.';
  const wasRunning = s.running;
  if (!wasRunning) {
    const err = startBot();
    if (err) return err;
  }
  set({
    blitz: { startedAt: now, endsAt: now + BLITZ_MINUTES * 60_000, startEquity: accountValue(px), wasRunning },
    blitzUsedOn: dayStart(now),
    settings: blitzSettings(s.account, s.controls, s.tradingMode),
    // Decide from the next minute that closes.
    lastDecisionBar: Math.floor(now / 60_000) * 60 - 60,
    signals: {},
  });
  waitingFor = 0;
  get().log(
    'info',
    `Blitz started: quick trades on the 1-minute chart until ${clock(now + BLITZ_MINUTES * 60_000, false)}. Buys or sells short whenever the 1-minute chart leans one way (score ±30) and holds while it keeps going, behind a stop that trails 0.5% behind the best price.${s.controls.blitzMaxSpend ? ` ${s.controls.blitzMinSpend ? `${money(s.controls.blitzMinSpend / s.account.rate)}–` : 'Up to '}${money(s.controls.blitzMaxSpend / s.account.rate)} a trade.` : ''} It stops early if the session loses ${BLITZ_STOP_PCT}% (${money((accountValue(px) * BLITZ_STOP_PCT) / 100)}). Every trade pays fees, so expect small losses.`,
  );
  get().toast('info', 'Blitz started: 2 hours of quick trades');
  return null;
}

/** Ends the Blitz session: closes its open trade and goes back to your normal settings. */
export function stopBlitz(reason: string) {
  const s = get();
  const b = s.blitz;
  if (!b) return;
  pendingLimit = null;
  const pos = s.positions[0];
  if (pos?.blitz) closeById(pos.id, reason);
  const after = get();
  const px = currentPrice();
  const made = accountValue(px) - b.startEquity;
  const trades = after.trades.filter((t) => t.blitz && t.entryTime >= b.startedAt);
  const sec = TIMEFRAMES[after.controls.timeframe].barSec;
  set({
    blitz: null,
    settings: settingsFor(after.account, after.controls, after.tradingMode),
    lastDecisionBar: Math.floor(Date.now() / 1000 / sec) * sec - sec,
    signals: {},
  });
  get().log(
    'info',
    `Blitz ended: ${reason}. ${trades.length} trade${trades.length === 1 ? '' : 's'}, ${trades.filter((t) => t.pnl > 0).length} won, ${signedMoney(made)} after ${money(trades.reduce((a, t) => a + t.fees, 0))} of fees. Next Blitz from midnight.`,
  );
  get().toast(made >= 0 ? 'good' : 'bad', `Blitz ended ${signedMoney(made)}`);
  if (!b.wasRunning) stopBot('The bot was off before Blitz, so it stops again.');
}

/* ------------------------------------------------------------ the bot loop */

function onBotBar(_symbol: string, candles: Candle[], closed: Candle | null) {
  const px = candles[candles.length - 1]?.close;
  if (!px) return;
  const now = Date.now();
  const s = get();

  // Time without live prices while running counts as offline; history reload catches up on it.
  if (s.running && lastTick && now - lastTick > OFFLINE_MS) {
    set({ offlineMs: s.offlineMs + (now - lastTick) });
    get().log('warn', `No live prices for ${duration(now - lastTick)} (computer asleep or offline).`, SYMBOL);
  }
  lastTick = now;
  if ((s.running || s.positions.length) && now - lastSeenSaved > 30_000) {
    lastSeenSaved = now;
    set({ lastSeen: now });
  }

  // 1. Stop loss and take profit, on every tick, even while the bot is stopped. While catching up,
  // the missed minutes decide first, so a stop hit while offline fills at its real price.
  const pos = s.positions[0];
  if (pos?.real) {
    // Binance holds the stop; the bot takes profit itself, and sells if the price falls through the stop.
    const mark = markPrice(pos, px);
    if (pos.takeProfit && mark >= pos.takeProfit) closeById(pos.id, 'Take profit hit');
    else if (pos.stopLoss && mark <= pos.stopLoss * (pos.real.stopOrderId ? 1 - STOP_BACKUP_GAP : 1)) closeById(pos.id, 'Price fell through the stop loss; sold at market');
  } else if (pos && !catchingUp) {
    const hit = protectiveExit(pos, px);
    if (hit) closeById(pos.id, hit.reason);
    else if (maxHoldMs() && now - pos.entryTime >= maxHoldMs()) closeById(pos.id, `Held ${s.settings.maxHoldMin} minutes`);
    else if (s.settings.trailingStop) {
      const t = trail(pos, px, pos.trailPct ?? s.settings.stopLossPct);
      if (t) set({ positions: get().positions.map((p) => (p.id === pos.id ? { ...p, ...t } : p)) });
    }
  }

  // 2. Live reading for the meter, about once a second. In Live mode the same reading, which
  // includes the candle still forming, sells straight away when the chart turns.
  if (now - lastDisplay > 900) {
    lastDisplay = now;
    const live = evaluate(s.settings.strategy, candles);
    set({ signals: { [SYMBOL]: { ...live, time: now } } });
    const held = get().positions[0];
    if (s.running && s.settings.liveExits && held && !catchingUp && live.ready && live.action === 'sell') {
      closeById(held.id, `Chart turned: ${live.reasons.join(', ').toLowerCase()}`);
    }
  }

  if (!s.running) return;
  snapshot(now, px);

  // Blitz's waiting order: fill when the price reaches it, cancel when it has waited long enough.
  if (pendingLimit && (!s.blitz || get().positions.length)) pendingLimit = null;
  if (pendingLimit && s.blitz) {
    const o = pendingLimit;
    if (o.side === 'long' ? px <= o.limit : px >= o.limit) {
      pendingLimit = null;
      applyOpen(o.side, o.amount, `Limit order filled. ${o.reason}`, { ...o.levels, blitz: true }, { price: o.limit });
    } else if (now >= o.expires) {
      pendingLimit = null;
      get().log('info', `Blitz: the limit order to ${o.side === 'long' ? 'buy' : 'sell short'} at ${fmtPrice(o.limit)} didn't fill in 3 minutes, so it was cancelled.`, SYMBOL);
    }
  }

  // Blitz: two hours at most, and an early stop if the session loses too much.
  if (s.blitz && !catchingUp) {
    if (now >= s.blitz.endsAt) return stopBlitz('its 2 hours are up');
    if (!realBusy() && accountValue(px) - s.blitz.startEquity <= -(s.blitz.startEquity * BLITZ_STOP_PCT) / 100) {
      return stopBlitz(`it stopped early after losing ${BLITZ_STOP_PCT}% this session`);
    }
  }

  // Your trading hours ended: close the bot's open trade if you asked for that.
  const held = get().positions[0];
  if (held && held.openedBy === 'bot' && s.controls.hours && s.controls.closeAfterHours && !inHours(s.controls.hours, now) && !realBusy() && now - lastHoursClose > 30_000) {
    lastHoursClose = now;
    closeById(held.id, `Your trading hours (${describeHours(s.controls.hours)}) ended`);
  }

  // Your loss limit: stop the bot and sell.
  if (s.settings.maxLoss > 0 && s.test && !realBusy() && accountValue(px) - s.test.startEquity <= -s.settings.maxLoss) {
    closeAll(() => true, 'Loss limit reached');
    stopBot(`Loss limit of ${money(s.settings.maxLoss)} reached: the bot stopped and sold.`);
    get().toast('bad', 'Loss limit reached. The bot stopped.');
    return;
  }

  // 3. Decide when a strategy candle closes, once per candle. A signal held back by your hours or
  // daily limit is checked again every minute while its candle is still the latest one.
  const lastClosed = candles[candles.length - 2];
  if (closed && closed.time > get().lastDecisionBar) decideOnClosed(candles.slice(0, -1), closed, px, now);
  else if (waitingFor && lastClosed && waitingFor === lastClosed.time && !get().positions.length && now - lastRetry > 60_000) {
    lastRetry = now;
    decide(evaluate(s.settings.strategy, candles.slice(0, -1)), px, now, true);
  } else if (waitingFor && lastClosed && waitingFor !== lastClosed.time) waitingFor = 0;
}

function decideOnClosed(history: Candle[], closed: Candle, px: number, now: number, late = false) {
  set({ lastDecisionBar: closed.time });
  waitingFor = 0;
  void refreshLessons(history, get().settings, get().controls.timeframe);
  // Blitz with an algorithm: it decides which way to be, every minute.
  const engine = get().controls.blitzEngine;
  if (get().blitz && engine && engine !== 'chart') return blitzAlgoStep(engine, history, px, now);
  const sig = evaluate(get().settings.strategy, history);
  if (late) {
    const closedAt = (closed.time + mode().barSec) * 1000;
    const verdict = sig.action ? `The chart says ${sig.action}.` : `Score ${fmtScore(sig.score)}.`;
    get().log('info', `Catching up on the ${mode().candle} candle that closed at ${clock(closedAt, false)}, ${duration(now - closedAt)} ago. ${verdict}`, SYMBOL);
  }
  decide(sig, px, now);
}

function decide(sig: Signal, px: number, now: number, retry = false) {
  const s = get();
  const st = s.settings;
  const why = sig.reasons.slice(0, 3).join('; ');
  const pos = s.positions[0];
  const d = decideTrade({
    signal: sig,
    settings: st,
    position: pos,
    cash: s.cash,
    equity: accountValue(px),
    botInvested: pos ? pos.collateral : 0,
    recentEntries: s.orderTimes.filter((t) => t > now - 60000).length,
    msSinceExit: now - Math.max(lastExit, realLastExit()),
  });
  switch (d.kind) {
    case 'warmup':
      return think('warmup', `${NAME}: ${sig.reasons[0]}.`, now);
    case 'exit':
      return void closeById(pos!.id, d.reason);
    case 'hold': {
      const view = sig.action ? 'the chart still looks good' : `score ${fmtScore(sig.score)}`;
      return think(`hold`, `${NAME}: holding ${pos!.side}, ${view}. Unrealised ${signedMoney(unrealized(pos!, px))}. Stop ${fmtPrice(pos!.stopLoss ?? 0)}${pos!.takeProfit ? `, target ${fmtPrice(pos!.takeProfit)}` : ''}.`, now);
    }
    case 'idle':
      if (sig.action) return think(`idle:${why}`, `${NAME}: not buying yet. ${why}.`, now);
      return think('idle', `${NAME}: score ${fmtScore(sig.score)}, needs ${st.allowShort ? '±' : '+'}${st.minConfidence} to trade. Waiting for the next ${mode().candle} candle. ${why}.`, now);
    case 'blocked': {
      const lead = sig.action ? `${NAME}: the chart says buy, but it was` : `${NAME}: ${d.side === 'long' ? 'buy' : 'sell'} signal ${fmtScore(sig.score)}`;
      const text =
        d.why === 'fees'
          ? `${lead} skipped: the market is too quiet for the move to cover fees.`
          : d.why === 'budget'
            ? `${lead} skipped: only ${money(s.cash)} cash is left.`
            : d.why === 'cooldown' && d.waitMs
              ? `${lead} skipped: waiting ${duration(d.waitMs)} more after the last sale.`
              : `${lead} skipped (${d.why}).`;
      return blocked(d.why, text, now);
    }
    case 'enter': {
      const c = s.controls;
      const closedBars = botHub.candles(SYMBOL).slice(0, -1);
      const situation = situationNow(closedBars, st, d.side);
      const what = d.side === 'long' ? 'Buy' : 'Short';
      // Blitz has its own limits (2 hours, once a day), so your hours, daily limit and the lessons don't apply.
      if (s.blitz) {
        waitingFor = 0;
        if (c.blitzEntry === 'limit' && s.tradingMode === 'paper') {
          // A waiting order a quarter of a typical 1-minute move better than the price.
          const offset = px * ((sig.atrPct ?? 0.05) / 100) * LIMIT_OFFSET_ATR;
          const limit = d.side === 'long' ? px - offset : px + offset;
          pendingLimit = { side: d.side, amount: d.amount, limit, expires: now + LIMIT_WAIT_MS, reason: d.reason, levels: { stopPct: d.stopPct, targetPct: d.targetPct } };
          get().log('info', `Blitz: waiting to ${d.side === 'long' ? 'buy' : 'sell short'} ${money(d.amount)} at ${fmtPrice(limit)} or better (limit order, up to 3 minutes; now ${fmtPrice(px)}). ${d.reason}`, SYMBOL);
          return;
        }
        return applyOpen(d.side, d.amount, d.reason, { ...d, blitz: true });
      }
      // Your trading hours and daily limit: wait, and try again every minute while the signal is current.
      if (!inHours(c.hours, now)) {
        waitingFor = get().lastDecisionBar;
        return blocked('hours', `${NAME}: ${what.toLowerCase()} signal ${fmtScore(sig.score)}, waiting for your trading hours (${describeHours(c.hours)}).`, now, 4 * 3_600_000);
      }
      const today = dayStart(now);
      const tradesToday = s.trades.filter((t) => t.openedBy === 'bot' && t.entryTime >= today).length + s.positions.filter((p) => p.entryTime >= today).length;
      if (c.dailyTrades && tradesToday >= c.dailyTrades) {
        waitingFor = get().lastDecisionBar;
        return blocked('daily', `${NAME}: ${what.toLowerCase()} signal ${fmtScore(sig.score)}, but today's ${c.dailyTrades} trade${c.dailyTrades > 1 ? 's are' : ' is'} used up.`, now, 4 * 3_600_000);
      }
      // Lessons: skip a situation that has kept losing, if you turned this on.
      if (c.learnSkip && situation) {
        const v = lessonVerdict(useLessons.getState().lessons, situation as Situation);
        if (v.skip && v.rec) {
          waitingFor = 0;
          return blocked(
            `lesson:${situation}`,
            `${NAME}: ${what.toLowerCase()} signal ${fmtScore(sig.score)} skipped. Lesson: ${describeSituation(situation).toLowerCase()} won only ${v.rec.wins} of ${v.rec.n} times so far.`,
            now,
          );
        }
      }
      // The neural network: its view goes in the log; it skips the signal only once it has earned trust.
      const brain = useLessons.getState().brain;
      const x = brain && useLessons.getState().timeframe === c.timeframe ? inputsNow(closedBars, sig.score, mode().barSec) : null;
      const view = brain && x && brain.learned >= BRAIN_WARMUP ? brainView(brain, x) : null;
      if (c.brain && brain && x && view && trusted(brain) && wouldSkip(brain, x)) {
        waitingFor = 0;
        return blocked(
          'brain',
          `${NAME}: ${what.toLowerCase()} signal ${fmtScore(sig.score)} skipped by the neural network. It gives it a ${Math.round(view.p * 100)}% chance of reaching the target, and the signals it skipped before lost ${(-brain.skippedR / brain.skippedN).toFixed(2)}× the risk on average.`,
          now,
        );
      }
      const netNote = view ? ` Neural network: ${Math.round(view.p * 100)}% chance of reaching the target.` : '';
      if (s.tradingMode !== 'paper' && d.amount < 5) {
        waitingFor = 0;
        return blocked('minimum', `${NAME}: buy signal ${fmtScore(sig.score)} skipped: the most a trade can lose (${c.riskPct}%) allows only ${money(d.amount)}, under Binance's 5 USDT minimum order.`, now);
      }
      waitingFor = 0;
      applyOpen(d.side, d.amount, `${retry ? 'Signal from the last 4-hour candle, taken now that your hours and daily limit allow it. ' : ''}${d.reason}${netNote}`, { ...d, situation });
    }
  }
}

/**
 * One minute of a Blitz algorithm: move the open trade's stop with the chart, then buy, sell short,
 * close or flip so the bot is the way the algorithm wants to be.
 */
function blitzAlgoStep(algo: BlitzAlgo, history: Candle[], px: number, now: number) {
  const bars = history.slice(-400);
  if (bars.length < 160) return;
  const c = readAlgoChart(bars);
  const i = bars.length - 1;
  const s = get();
  const pos = s.positions[0];
  const held: Want = pos ? (pos.side === 'long' ? 1 : -1) : pendingLimit ? (pendingLimit.side === 'long' ? 1 : -1) : 0;
  // Move the stop with the chart, never backwards.
  if (pos && pos.blitz && !pos.real && pos.stopLoss) {
    const side = pos.side === 'long' ? 1 : -1;
    const best = side === 1 ? Math.max(pos.peak, bars[i].high) : Math.min(pos.peak, bars[i].low);
    const stop = algoTrail(algo, c, i, side, pos.stopLoss, best);
    if (stop !== pos.stopLoss || best !== pos.peak) set({ positions: get().positions.map((p) => (p.id === pos.id ? { ...p, stopLoss: stop, peak: best } : p)) });
  }
  const want = algoWant(algo, bars, c, i, held);
  if (want === held) return;
  const name = ALGO_LABEL[algo].split(':')[0];
  if (pendingLimit && want !== (pendingLimit.side === 'long' ? 1 : -1)) pendingLimit = null;
  if (pos && want !== (pos.side === 'long' ? 1 : -1)) {
    closeById(pos.id, want === 0 ? `${name}: out` : `${name}: flipping to ${want === 1 ? 'buy' : 'sell short'}`);
  }
  if (want === 0 || get().positions.length) return;
  const st = s.settings;
  const side: Side = want === 1 ? 'long' : 'short';
  if (side === 'short' && !st.allowShort) return;
  const amount = Math.floor(Math.min(st.tradeAmount, get().cash / (1 + st.feePct / 100)) * 100) / 100;
  if (amount < Math.max(1, st.minTradeAmount ?? 0)) return blocked('budget', `${NAME}: ${name} wants to ${side === 'long' ? 'buy' : 'sell short'}, but only ${money(get().cash)} cash is left.`, now);
  const stop = algoStop(algo, c, i, want, px);
  const stopPct = (Math.abs(px - stop) / px) * 100;
  const reason = `${name}.`;
  if (s.controls.blitzEntry === 'limit' && s.tradingMode === 'paper') {
    const offset = c.atr[i] * 0.25;
    const limit = side === 'long' ? px - offset : px + offset;
    pendingLimit = { side, amount, limit, expires: now + LIMIT_WAIT_MS, reason, levels: { stopPct, targetPct: 0 } };
    get().log('info', `Blitz: waiting to ${side === 'long' ? 'buy' : 'sell short'} ${money(amount)} at ${fmtPrice(limit)} or better (limit order, up to 3 minutes; now ${fmtPrice(px)}). ${reason}`, SYMBOL);
    return;
  }
  applyOpen(side, amount, reason, { stopPct, targetPct: 0, blitz: true });
}

function think(key: string, message: string, now: number) {
  // One line per decision; the same view is not repeated within a minute. On 1-minute candles,
  // a thought is written at most every 10 minutes, so trades stay easy to find in the log.
  const gap = mode().barSec < 600 ? 10 * 60_000 : 60_000;
  if ((lastThought.key === key || gap > 60_000) && now - lastThought.time < gap) return;
  lastThought.key = key;
  lastThought.time = now;
  get().log('think', message, SYMBOL);
}

function blocked(key: string, message: string, now: number, gapMs = mode().barSec < 600 ? 10 * 60_000 : 20_000) {
  if (now - (lastBlocked.get(key) ?? 0) < gapMs) return;
  lastBlocked.set(key, now);
  get().log('warn', message, SYMBOL);
}

/** Hourly account snapshot for the paper-test chart. */
function snapshot(now: number, px: number, force = false) {
  const snaps = get().snapshots;
  const last = snaps[snaps.length - 1];
  if (!force && last && Math.floor(last.time / 3_600_000) === Math.floor(now / 3_600_000)) return;
  set({ snapshots: [...snaps, { time: now, equity: accountValue(px), price: px }].slice(-MAX_SNAPSHOT_COUNT) });
}

/* --------------------------------------------------------------- catching up */

/**
 * Runs whenever the bot's candles are (re)loaded: on opening the app and after every reconnect.
 * Replays the 1-minute prices the app missed to settle any stop or target that was hit, then acts
 * on the latest finished strategy candle if it hasn't yet.
 */
async function catchUp() {
  const s = get();
  if (catchingUp || (!s.running && !s.positions.length)) return;
  catchingUp = true;
  try {
    const now = Date.now();
    // Account for the gap first, before any live tick can count it again.
    const gapStart = lastTick || s.lastSeen;
    lastTick = now;
    if (s.running && gapStart && now - gapStart > OFFLINE_MS) {
      set({ offlineMs: get().offlineMs + (now - gapStart), lastSeen: now });
      get().log('info', `Back after ${duration(now - gapStart)} without live prices. Checking what happened in between.`, SYMBOL);
    } else {
      set({ lastSeen: now });
    }
    // Stops and targets are settled even while the bot is paused. Real positions: Binance holds the stop.
    const pos = s.positions[0];
    if (pos?.real) await checkRealStops();
    else if (pos && gapStart && now - gapStart > 90_000) {
      const from = Math.max(Math.floor(gapStart / 1000), Math.floor(pos.entryTime / 1000), Math.floor(now / 1000) - 30 * 86_400);
      try {
        const minutes = await fetchBinanceKlines(SYMBOL, '1m', from, Math.floor(now / 1000));
        settleMissedExit(pos, minutes);
      } catch (e) {
        get().log('warn', `Couldn't load the prices missed while offline (${(e as Error).message}). Checking the stop and target from now on.`, SYMBOL);
      }
    }
    const candles = botHub.candles(SYMBOL);
    const closed = candles[candles.length - 2];
    if (get().running && closed && closed.time > get().lastDecisionBar) decideOnClosed(candles.slice(0, -1), closed, candles[candles.length - 1].close, Date.now(), true);
  } finally {
    catchingUp = false;
  }
}

/** Walks missed minutes; if the stop, target or time limit was reached, closes there at that time. */
function settleMissedExit(pos: Position, minutes: Candle[]) {
  const hold = maxHoldMs();
  for (const c of minutes) {
    const adverse = pos.side === 'long' ? c.low : c.high;
    const favourable = pos.side === 'long' ? c.high : c.low;
    // As in the backtests, if both could have hit in the same minute, assume the stop did.
    const stop = protectiveExit(pos, adverse);
    if (stop && pos.stopLoss !== null && stop.level === pos.stopLoss) {
      const price = pos.side === 'long' ? Math.min(c.open, pos.stopLoss) : Math.max(c.open, pos.stopLoss);
      closeById(pos.id, `${stop.reason} while the app was closed`, { price, time: (c.time + 60) * 1000 });
      return;
    }
    const target = protectiveExit(pos, favourable);
    if (target && pos.takeProfit !== null) {
      const price = pos.side === 'long' ? Math.max(c.open, pos.takeProfit) : Math.min(c.open, pos.takeProfit);
      closeById(pos.id, `${target.reason} while the app was closed`, { price, time: (c.time + 60) * 1000 });
      return;
    }
    if (hold && (c.time + 60) * 1000 - pos.entryTime >= hold) {
      closeById(pos.id, `Held ${get().settings.maxHoldMin} minutes while the app was closed`, { price: c.close, time: (c.time + 60) * 1000 });
      return;
    }
  }
}

/* ------------------------------------------------------------------- wiring */

let started = false;

export function initEngine() {
  if (started) return;
  started = true;
  const s = get();
  botHub.onBar(onBotBar);
  botHub.watch(SYMBOL, (full) => {
    if (!full) return;
    void refreshLessons(botHub.candles(SYMBOL).slice(0, -1), get().settings, get().controls.timeframe);
    void catchUp();
  });
  botHub.sync([MARKET], mode().interval);
  hub.sync([MARKET], s.interval);
  useStore.subscribe((st, prev) => {
    if (st.interval !== prev.interval) hub.sync([MARKET], st.interval);
    if (!!st.blitz !== !!prev.blitz) {
      // Blitz on: 1-minute candles. Blitz off: back to your timeframe.
      botHub.sync([MARKET], mode().interval);
    } else if (st.controls.timeframe !== prev.controls.timeframe && !st.blitz) {
      const sec = TIMEFRAMES[st.controls.timeframe].barSec;
      waitingFor = 0;
      // Decide from the next new candle on, not on one that closed before the switch.
      set({ signals: {}, lastDecisionBar: Math.floor(Date.now() / 1000 / sec) * sec - sec });
      botHub.sync([MARKET], TIMEFRAMES[st.controls.timeframe].interval);
      get().log('info', `The bot now decides ${TIMEFRAMES[st.controls.timeframe].label.toLowerCase()}, on ${TIMEFRAMES[st.controls.timeframe].candle} candles. It is relearning from their history.`);
    }
  });
  if (s.running) {
    keepAwake(true);
    get().log('info', `App reopened. The bot is still running and is checking what happened while it was closed.`);
  }
  // Real trading: the Binance connection, its balance, and the stops it holds.
  void refreshReal().then(() => syncRealCash());
  setInterval(() => {
    if (get().positions.some((p) => p.real)) void checkRealStops();
  }, 15_000);
  setInterval(() => void syncRealCash(), 60_000);
  // Watchdog: report when live prices stop arriving.
  let warned = false;
  setInterval(() => {
    const st = botHub.status(SYMBOL);
    const stale = !st?.updatedAt || Date.now() - st.updatedAt > OFFLINE_MS;
    if (get().running && stale && !warned) {
      warned = true;
      get().log('warn', `No live BTC prices right now${st?.note ? `: ${st.note}` : ''}. The bot will catch up when they return.`, SYMBOL);
    }
    if (!stale) warned = false;
  }, 30_000);
}
