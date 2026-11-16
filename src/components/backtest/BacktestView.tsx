import { useEffect, useMemo, useState } from 'react';
import { SPEEDS, backtestCash, runBacktestNow, useBacktest } from '../../store/useBacktest';
import { botSpec, useStore } from '../../store/useStore';
import type { BacktestResult } from '../../engine/backtest';
import { downloadText, duration, money, pct, price, signedMoney, toCsv } from '../../lib/format';
import { Stepper } from '../Fields';
import { Icon } from '../Icon';
import { BacktestChart } from './BacktestChart';

const fmtDate = (sec: number) => new Date(sec * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function BacktestView() {
  useReplayClock();
  return (
    <main className="main">
      <ChartArea />
      <SetupPanel />
      <ResultTabs />
    </main>
  );
}

/** Advances the replay cursor in step with real time, so a long test plays back in the chosen time. */
function useReplayClock() {
  const status = useBacktest((s) => s.status);
  const paused = useBacktest((s) => s.paused);
  useEffect(() => {
    if (status !== 'replaying' || paused) return;
    let last = performance.now();
    const t = setInterval(() => {
      const s = useBacktest.getState();
      if (!s.data || !s.result) return;
      const now = performance.now();
      const span = s.data.end - s.data.start;
      const cursor = Math.min(s.data.end, s.cursor + (span / s.speed) * ((now - last) / 1000));
      last = now;
      s.set(cursor >= s.data.end ? { cursor: s.data.end, status: 'done' } : { cursor });
    }, 100);
    return () => clearInterval(t);
  }, [status, paused]);
}

/** Stats for everything the replay has revealed so far. */
function useStatsSoFar(result: BacktestResult | null, cursor: number) {
  return useMemo(() => {
    if (!result) return null;
    const done = result.trades.filter((t) => t.exitTime <= cursor * 1000);
    const pts = result.equity.filter((p) => p.time <= cursor);
    const start = result.stats.startCash;
    let peak = start;
    let dd = 0;
    for (const p of pts) {
      peak = Math.max(peak, p.value);
      dd = Math.max(dd, ((peak - p.value) / peak) * 100);
    }
    const eq = pts.length ? pts[pts.length - 1].value : start;
    const bars = result.bars;
    const lastBar = bars.filter((b) => b.time <= cursor).at(-1) ?? bars[0];
    const wins = done.filter((t) => t.pnl > 0).length;
    return {
      equity: eq,
      pnl: eq - start,
      start,
      trades: done.length,
      winRate: done.length ? (wins / done.length) * 100 : 0,
      fees: done.reduce((s, t) => s + t.fees, 0),
      dd,
      holdPct: bars.length ? ((lastBar.close - result.stats.startPrice) / result.stats.startPrice) * 100 : 0,
    };
  }, [result, cursor]);
}

function ChartArea() {
  const { result, cursor, status, message, data, progress } = useBacktest();
  const timeframe = useStore((s) => botSpec(s.controls).interval);
  return (
    <section className="panel area-chart" aria-label="Backtest chart">
      <div className="chart-head">
        <div className="chart-title">
          <h1>
            Backtest BTC/USDT
            <span className="name">{data ? `${fmtDate(data.start)} – ${fmtDate(data.end)}` : 'Replay past prices through the bot'}</span>
          </h1>
          {data && (
            <span className="feed-pill">
              <span className="feed-dot" data-status="live" />
              Real Binance prices
            </span>
          )}
        </div>
        {result && data && (
          <div className="chart-tools">
            <ReplayControls />
          </div>
        )}
      </div>
      <div className="chart-body">
        {result && data ? (
          <>
            <BacktestChart result={result} cursor={cursor} timeframe={timeframe} />
            <div className="replay-clock" aria-live="off">
              <span className="num">{fmtDate(Math.min(cursor, data.end))}</span>
              <span className="bar-mini">
                <i style={{ width: `${((cursor - data.start) / (data.end - data.start)) * 100}%` }} />
              </span>
            </div>
          </>
        ) : (
          <div className="empty">
            {status === 'loading' || status === 'running' ? (
              <>
                <strong>{message}</strong>
                <span className="bar-mini" style={{ width: 220 }}>
                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
              </>
            ) : status === 'error' ? (
              <>
                <strong>The backtest could not run</strong>
                <p>{message}</p>
              </>
            ) : (
              <>
                <strong>Check the strategy on recent prices</strong>
                <p>Choose how many days to replay. The bot starts with {money(backtestCash())} and trades the past exactly as it trades live, with your settings from the Profile screen.</p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ReplayControls() {
  const { status, paused, set, data, speed } = useBacktest();
  if (status === 'done') return <span className="feed-pill">Replay finished</span>;
  return (
    <div className="order-bar">
      <span className="hint">{SPEEDS.find((s) => s.seconds === speed)?.label} replay</span>
      <button className="btn btn-sm" onClick={() => set({ paused: !paused })}>
        <Icon name={paused ? 'play' : 'stop'} /> {paused ? 'Resume' : 'Pause'}
      </button>
      <button className="btn btn-sm" onClick={() => data && set({ cursor: data.end, status: 'done' })}>
        Skip to end
      </button>
    </div>
  );
}

function SetupPanel() {
  const bt = useBacktest();
  const controls = useStore((s) => s.controls);
  const spec = botSpec(controls);
  const busy = bt.status === 'loading' || bt.status === 'running';
  const stats = useStatsSoFar(bt.result, bt.cursor);
  return (
    <aside className="panel area-bot bot-panel" aria-label="Backtest setup">
      <div className="bot-head">
        <div className="bot-title">
          <h2>Backtest</h2>
          <span className="status-pill" data-on={bt.status === 'replaying' && !bt.paused}>
            <span className="feed-dot" />
            {bt.status === 'replaying' ? (bt.paused ? 'Paused' : 'Replaying') : bt.status === 'done' ? 'Finished' : `Starts with ${money(backtestCash())}`}
          </span>
        </div>
        <button className="power" onClick={runBacktestNow} disabled={busy}>
          <Icon name="play" />
          {bt.result ? 'Run again' : 'Run backtest'}
        </button>
        {stats && <LiveStats stats={stats} />}
      </div>
      <div className="settings">
        <section className="section">
          <h3>Period</h3>
          <div className="field-grid">
            <Stepper label="Days of history" value={bt.days} min={1} max={120} onChange={(days) => bt.set({ days })} hint="1 to 120 days, ending now" />
            <div className="field full">
              <span className="field-label">Replay speed</span>
              <div className="segmented" role="group" aria-label="Replay speed">
                {SPEEDS.map((s) => (
                  <button key={s.seconds} aria-pressed={bt.speed === s.seconds} onClick={() => bt.set({ speed: s.seconds })}>
                    {s.label}
                  </button>
                ))}
              </div>
              <span className="hint">{bt.speed ? `${bt.days} days of trading play back in ${duration(bt.speed * 1000)}.` : 'Shows the finished result straight away.'}</span>
            </div>
          </div>
        </section>
        <section className="section">
          <h3>Strategy</h3>
          <p className="hint">
            The live bot's strategy, {spec.label}: {spec.summary}. 0.1% fee and 0.02% slippage per order. Stops and targets are checked on every
            1-minute candle. It uses your settings from the Profile screen (most lost a trade, shorting); trading hours, the daily limit and the neural network apply only live.
          </p>
        </section>
      </div>
    </aside>
  );
}

function LiveStats({ stats }: { stats: NonNullable<ReturnType<typeof useStatsSoFar>> }) {
  const tone = (n: number) => (n > 0.005 ? 'up' : n < -0.005 ? 'down' : '');
  return (
    <div className="session-grid">
      <div>
        <span className="stat-label">Account value</span>
        <span className="stat-value num">{money(stats.equity)}</span>
      </div>
      <div>
        <span className="stat-label">Profit / loss</span>
        <span className={`stat-value num ${tone(stats.pnl)}`}>
          {signedMoney(stats.pnl)} <small>{pct((stats.pnl / stats.start) * 100)}</small>
        </span>
      </div>
      <div>
        <span className="stat-label">Just holding</span>
        <span className={`stat-value num ${tone(stats.holdPct)}`}>{pct(stats.holdPct)}</span>
      </div>
      <div>
        <span className="stat-label">Trades · win rate</span>
        <span className="stat-value num">
          {stats.trades} <span className="muted">· {stats.winRate.toFixed(0)}%</span>
        </span>
      </div>
      <div>
        <span className="stat-label">Biggest drop</span>
        <span className="stat-value num">{stats.dd.toFixed(2)}%</span>
      </div>
      <div>
        <span className="stat-label">Fees paid</span>
        <span className="stat-value num">{money(stats.fees)}</span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- results */

type Tab = 'trades' | 'log';

function ResultTabs() {
  const [tab, setTab] = useState<Tab>('trades');
  const { result, cursor } = useBacktest();
  const tradesShown = result ? result.trades.filter((t) => t.exitTime <= cursor * 1000).length : 0;
  return (
    <section className="panel area-tabs">
      <div className="tabbar" role="tablist" aria-label="Backtest results">
        {(
          [
            ['trades', 'Trades', tradesShown],
            ['log', 'AI log', 0],
          ] as const
        ).map(([id, label, n]) => (
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
            {n ? <span className="count">{n}</span> : null}
          </button>
        ))}
        <div className="tab-tools">
          {tab === 'trades' && result && (
            <button className="btn btn-sm btn-ghost" onClick={() => exportTrades(result)}>
              <Icon name="download" /> Export CSV
            </button>
          )}
        </div>
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === 'trades' && <TradesTable />}
        {tab === 'log' && <ReplayLog />}
      </div>
    </section>
  );
}

function exportTrades(r: BacktestResult) {
  downloadText(
    'crdtrade-backtest-trades.csv',
    toCsv([
      ['Opened', 'Closed', 'Side', 'Entry', 'Exit', 'P&L', 'P&L %', 'Fees', 'Entry reason', 'Exit reason'],
      ...r.trades.map((t) => [new Date(t.entryTime).toISOString(), new Date(t.exitTime).toISOString(), t.side, t.entryPrice, t.exitPrice, t.pnl.toFixed(2), t.pnlPct.toFixed(2), t.fees.toFixed(2), t.entryReason, t.exitReason]),
    ]),
  );
}

function TradesTable() {
  const { result, cursor } = useBacktest();
  const list = useMemo(() => (result ? result.trades.filter((t) => t.exitTime <= cursor * 1000).reverse() : []), [result, cursor]);
  if (!result) return <Empty title="No backtest yet" body="Run a backtest and every trade the bot makes will be listed here." />;
  if (!list.length) return <Empty title="No finished trades yet" body="The bot trades about 3 times a month. Trades appear here as the replay reaches them." />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Bought / shorted</th>
          <th>Closed</th>
          <th>Side</th>
          <th className="r">Entry</th>
          <th className="r">Exit</th>
          <th className="r">P&amp;L</th>
          <th>Why it opened</th>
          <th>Why it closed</th>
        </tr>
      </thead>
      <tbody>
        {list.map((t) => (
          <tr key={t.id}>
            <td className="num">{fmtDate(t.entryTime / 1000)}</td>
            <td className="num">{fmtDate(t.exitTime / 1000)}</td>
            <td>
              <span className="side-tag" data-side={t.side}>
                {t.side === 'long' ? 'Long' : 'Short'}
              </span>
            </td>
            <td className="r num">{price(t.entryPrice)}</td>
            <td className="r num">{price(t.exitPrice)}</td>
            <td className={`r num ${t.pnl >= 0 ? 'up' : 'down'}`}>
              {signedMoney(t.pnl)} <small>{pct(t.pnlPct)}</small>
            </td>
            <td className="reason-cell" title={t.entryReason}>
              {t.entryReason}
            </td>
            <td className="reason-cell" title={t.exitReason}>
              {t.exitReason}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReplayLog() {
  const { result, cursor } = useBacktest();
  const list = useMemo(() => (result ? result.log.filter((l) => l.time <= cursor * 1000).slice(-300).reverse() : []), [result, cursor]);
  if (!list.length) return <Empty title="Nothing logged yet" body="The bot explains each buy and sell here as the replay reaches it." />;
  return (
    <ol className="log-list">
      {list.map((l, i) => (
        <li key={i} className="log-item" data-level={l.level}>
          <span className="log-time num">{fmtDate(l.time / 1000)}</span>
          <span className="log-kind" data-level={l.level}>
            {l.level === 'buy' ? 'Buy' : l.level === 'sell' ? 'Sell' : l.level === 'warn' ? 'Alert' : 'Info'}
          </span>
          <span className="log-msg">{l.message}</span>
        </li>
      ))}
    </ol>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
