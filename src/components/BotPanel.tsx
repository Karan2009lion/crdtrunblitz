import { useSyncExternalStore } from 'react';
import { useStore, BLITZ_MINUTES, BLITZ_STOP_PCT, SYMBOL, dayStart, describeHours, inHours, startCash } from '../store/useStore';
import { useNow, useQuotes } from '../hooks/useMarket';
import { botHub } from '../market/hub';
import { accountValue, closeById, nextDecisionTime, startBlitz, startBot, stopBlitz, stopBot } from '../engine/bot';
import { markPrice, unrealized } from '../engine/broker';
import { clock, dateTime, duration, money, pct, price, signedMoney } from '../lib/format';
import { Icon } from './Icon';

/** The main screen's bot panel: start and stop, the open trade, and the balance. Everything else is on Profile. */
export function BotPanel() {
  const running = useStore((s) => s.running);
  const test = useStore((s) => s.test);
  const toast = useStore((s) => s.toast);
  const tradingMode = useStore((s) => s.tradingMode);
  const setView = useStore((s) => s.setView);
  const now = useNow(1000);

  const toggle = () => {
    if (running) return stopBot('Bot stopped by you.');
    const err = startBot();
    if (err) toast('bad', err);
  };

  return (
    <aside className="panel area-bot bot-panel" aria-label="BTC trader">
      <div className="bot-head">
        <div className="bot-title">
          <h2>BTC trader</h2>
          <span className="status-pill" data-on={running} role="status">
            <span className="feed-dot" />
            {running && test ? `Running ${duration(now - test.startedAt)}` : test ? 'Stopped' : 'Not started'}
          </span>
        </div>
        <button className="power" data-on={running} onClick={toggle}>
          <Icon name={running ? 'stop' : 'play'} />
          {running ? 'Stop bot' : tradingMode === 'live' ? 'Start with real money' : tradingMode === 'testnet' ? 'Start on Testnet' : 'Start bot'}
        </button>
        <Status running={running} now={now} />
        <Balance />
        <OpenTrade />
        <Blitz now={now} />
        <button className="btn btn-ghost settings-link" onClick={() => setView('profile')}>
          Settings, fees and tax on Profile <span aria-hidden="true">→</span>
        </button>
      </div>
    </aside>
  );
}

/** Blitz: up to 2 hours of quick trades on the 1-minute chart, once a day. */
function Blitz({ now }: { now: number }) {
  const blitz = useStore((s) => s.blitz);
  const usedToday = useStore((s) => s.blitzUsedOn === dayStart(now));
  const tradingMode = useStore((s) => s.tradingMode);
  const holding = useStore((s) => s.positions.length > 0 && !s.positions[0].blitz);
  const trades = useStore((s) => s.trades);
  const toast = useStore((s) => s.toast);
  useStore((s) => s.positions);
  useStore((s) => s.cash);
  const px = useQuotes()[SYMBOL]?.last;
  if (blitz) {
    const done = trades.filter((t) => t.blitz && t.entryTime >= blitz.startedAt);
    const made = accountValue(px) - blitz.startEquity;
    return (
      <section className="blitz" data-on="true" aria-label="Blitz session">
        <div className="blitz-head">
          <strong>Blitz on</strong>
          <span className="num">{duration(Math.max(0, blitz.endsAt - now))} left</span>
        </div>
        <span className="hint">
          {done.length} trade{done.length === 1 ? '' : 's'}, {done.filter((t) => t.pnl > 0).length} won ·{' '}
          <span className={made >= 0 ? 'up' : 'down'}>{signedMoney(made)}</span> this session · stops early at −{BLITZ_STOP_PCT}%
        </span>
        <button className="btn btn-sm" onClick={() => stopBlitz('you stopped it')}>
          Stop Blitz
        </button>
      </section>
    );
  }
  const why = tradingMode !== 'paper' ? 'Paper trading only.' : usedToday ? 'Used today. Next Blitz from midnight.' : '';
  return (
    <section className="blitz" aria-label="Blitz">
      <div className="blitz-head">
        <strong>Blitz</strong>
        <span className="hint">{BLITZ_MINUTES / 60} hours of quick trades, once a day</span>
      </div>
      <span className="hint">
        Buys or sells short whenever the 1-minute chart leans one way and holds while it keeps going, behind a stop that trails 0.5% behind the best price. About 1 session in 5 ends up; on average fees make it lose a little.
      </span>
      <button
        className="btn btn-sm blitz-go"
        disabled={!!why}
        title={why || undefined}
        onClick={() => {
          const err = startBlitz(holding);
          if (err) toast('bad', err);
        }}
      >
        {holding ? 'Close the open trade and start Blitz' : 'Start Blitz'}
      </button>
      {why && <span className="hint">{why}</span>}
    </section>
  );
}

/** One line on what the bot is doing now, and whether live prices are arriving. */
function Status({ running, now }: { running: boolean; now: number }) {
  const snap = useSyncExternalStore(botHub.subscribeSnapshot, botHub.getSnapshot);
  const q = snap[SYMBOL];
  const controls = useStore((s) => s.controls);
  const holding = useStore((s) => s.positions.length > 0);
  const trades = useStore((s) => s.trades);
  const positions = useStore((s) => s.positions);
  const sig = useStore((s) => s.signals[SYMBOL]);
  const blitz = useStore((s) => !!s.blitz);
  const age = q?.updatedAt ? now - q.updatedAt : Infinity;
  const live = q?.status === 'live' && age < 120_000;
  const next = nextDecisionTime(now);
  const today = dayStart(now);
  const used = trades.filter((t) => t.openedBy === 'bot' && t.entryTime >= today).length + positions.filter((p) => p.entryTime >= today).length;
  const reading = sig?.ready ? (sig.score >= 50 ? 'momentum is up' : sig.score <= -50 ? 'momentum is down' : 'no clear momentum') : 'reading the chart';
  let text: string;
  if (!live) text = q?.updatedAt ? `No live prices for ${duration(age)}. The bot catches up when they return.` : (q?.note ?? 'Connecting to Binance…');
  else if (!running) text = 'Press Start. The bot watches BTC every second and trades on its own.';
  else if (holding) text = 'In a trade. The stop and target are checked on every price update.';
  else if (blitz) text = `Blitz: watching the 1-minute chart, ${reading}. Next decision at ${clock(next, false)}.`;
  else if (!inHours(controls.hours, now)) text = `Outside your trading hours (${describeHours(controls.hours)}). No new trades until then.`;
  else if (controls.dailyTrades && used >= controls.dailyTrades) text = `Today's ${controls.dailyTrades} trade${controls.dailyTrades > 1 ? 's are' : ' is'} used. Back tomorrow.`;
  else text = `Watching: ${reading}. Next decision at ${clock(next, false)} (in ${duration(next - now)}).`;
  return (
    <div className="health" data-ok={live}>
      <span className="feed-dot" data-status={live ? 'live' : q?.status === 'offline' ? 'offline' : 'connecting'} />
      <span>{text}</span>
    </div>
  );
}

function Balance() {
  const test = useStore((s) => s.test);
  const account = useStore((s) => s.account);
  const tradingMode = useStore((s) => s.tradingMode);
  const trades = useStore((s) => s.trades);
  useStore((s) => s.positions);
  useStore((s) => s.cash);
  const px = useQuotes()[SYMBOL]?.last;
  const eq = accountValue(px);
  const start = test?.startEquity ?? (tradingMode === 'paper' ? startCash(account) : eq);
  const pnl = eq - start;
  const tone = pnl > 0.005 ? 'up' : pnl < -0.005 ? 'down' : '';
  return (
    <div className="session-grid">
      <div>
        <span className="stat-label">Balance</span>
        <span className="stat-value num">{money(eq)}</span>
      </div>
      <div>
        <span className="stat-label">Profit</span>
        <span className={`stat-value num ${tone}`}>
          {signedMoney(pnl)} <small>{pct(start ? (pnl / start) * 100 : 0)}</small>
        </span>
      </div>
      <div>
        <span className="stat-label">Trades</span>
        <span className="stat-value num">
          {trades.length} <span className="muted">· {trades.filter((t) => t.pnl > 0).length} won</span>
        </span>
      </div>
      <div>
        <span className="stat-label">Started with</span>
        <span className="stat-value num">{money(start)}</span>
      </div>
    </div>
  );
}

function OpenTrade() {
  const p = useStore((s) => s.positions[0]);
  const px = useQuotes()[SYMBOL]?.last;
  if (!p) return null;
  const now = px ? markPrice(p, px) : p.entryPrice;
  const pnl = px ? unrealized(p, px) - p.entryFee : 0;
  return (
    <section className="open-trade" aria-label="Open trade">
      <div className="open-trade-head">
        <span className="side-tag" data-side={p.side}>
          {p.side === 'long' ? 'Bought' : 'Sold short'}
        </span>
        <span className={`num ${pnl >= 0 ? 'up' : 'down'}`}>
          {signedMoney(pnl)} <small>{pct((pnl / p.collateral) * 100)}</small>
        </span>
      </div>
      <dl className="spec">
        <dt>{p.side === 'long' ? 'Bought at' : 'Sold at'}</dt>
        <dd className="num">
          {price(p.entryPrice)} · {dateTime(p.entryTime)}
        </dd>
        <dt>Now</dt>
        <dd className="num">{price(now)}</dd>
        <dt>Amount</dt>
        <dd className="num">{money(p.collateral)}</dd>
        <dt>Stop · target</dt>
        <dd className="num">
          {p.stopLoss ? price(p.stopLoss) : '—'} · {p.takeProfit ? price(p.takeProfit) : '—'}
        </dd>
      </dl>
      <button className="btn btn-sm" onClick={() => closeById(p.id, 'Closed by you')}>
        Close trade now
      </button>
    </section>
  );
}
