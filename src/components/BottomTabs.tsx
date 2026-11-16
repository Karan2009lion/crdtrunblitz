import { memo, useEffect, useMemo, useState } from 'react';
import { useStore, startCash } from '../store/useStore';
import { clock, dateTime, downloadText, money, price, signedMoney, toCsv } from '../lib/format';
import type { LogLevel, Trade } from '../types';
import { Icon } from './Icon';

type Tab = 'trades' | 'log';

/** The main screen's lists: finished trades, and the bot's log. */
export function BottomTabs() {
  const [tab, setTab] = useState<Tab>('trades');
  const trades = useStore((s) => s.trades.length);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'trades', label: 'Trades', count: trades },
    { id: 'log', label: 'Bot log' },
  ];

  return (
    <section className="panel area-tabs">
      <div className="tabbar" role="tablist" aria-label="Activity">
        {tabs.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} role="tab" className="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
        <div className="tab-tools">{tab === 'log' ? <LogTools /> : <HistoryTools />}</div>
      </div>
      <div className="tab-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'trades' ? <History /> : <ActivityLog />}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- history */

function exportTrades(trades: Trade[]) {
  const rows: (string | number)[][] = [
    ['Opened', 'Closed', 'Market', 'Side', 'Quantity', 'Entry', 'Exit', 'Profit after fees', 'Profit %', 'Fees', 'Opened by', 'Entry reason', 'Exit reason'],
    ...trades.map((t) => [
      new Date(t.entryTime).toISOString(),
      new Date(t.exitTime).toISOString(),
      t.symbol,
      t.side,
      t.qty,
      t.entryPrice,
      t.exitPrice,
      t.pnl.toFixed(2),
      t.pnlPct.toFixed(2),
      t.fees.toFixed(2),
      t.openedBy,
      t.entryReason,
      t.exitReason,
    ]),
  ];
  downloadText(`crdtrade-trades-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
}

function HistoryTools() {
  const trades = useStore((s) => s.trades);
  if (!trades.length) return null;
  return (
    <button className="btn btn-sm btn-ghost" onClick={() => exportTrades(trades)}>
      <Icon name="download" /> Export CSV
    </button>
  );
}

function History() {
  const trades = useStore((s) => s.trades);
  const startEquity = useStore((s) => s.test?.startEquity ?? (s.tradingMode === 'paper' ? startCash(s.account) : null));
  const rows = useMemo(() => {
    let balance = startEquity ?? 0;
    return trades.map((t) => ({ t, balance: (balance += t.pnl) })).reverse();
  }, [trades, startEquity]);
  if (!rows.length) {
    return (
      <div className="empty">
        <strong>No trades yet</strong>
        <p>Each finished trade shows here: what it was bought at, when it was sold, its profit and the balance left.</p>
      </div>
    );
  }
  const anyShort = trades.some((t) => t.side === 'short');
  return (
    <>
      <table className="table trade-list">
        <thead>
          <tr>
            <th>Bought at</th>
            <th>Sold at</th>
            <th className="r">Profit</th>
            <th className="r">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, balance }) => {
            const buy = t.side === 'long' ? { px: t.entryPrice, time: t.entryTime } : { px: t.exitPrice, time: t.exitTime };
            const sell = t.side === 'long' ? { px: t.exitPrice, time: t.exitTime } : { px: t.entryPrice, time: t.entryTime };
            return (
              <tr key={t.id} title={`Opened: ${t.entryReason}\nClosed: ${t.exitReason}`}>
                <td className="num">
                  {price(buy.px)} <span className="muted">· {dateTime(buy.time)}</span>
                  {t.side === 'short' && (
                    <span className="side-tag" data-side="short" style={{ marginLeft: 6 }}>
                      Short
                    </span>
                  )}
                  {t.blitz && <span className="blitz-tag">Blitz</span>}
                </td>
                <td className="num">
                  {price(sell.px)} <span className="muted">· {dateTime(sell.time)}</span>
                </td>
                <td className={`r num ${t.pnl >= 0 ? 'up' : 'down'}`}>{signedMoney(t.pnl)}</td>
                <td className="r num">{startEquity === null ? '—' : money(balance)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {anyShort && <p className="hint table-note">Short trades sell first and buy back later, so they profit when BTC falls.</p>}
    </>
  );
}

/* ------------------------------------------------------------- activity log */

type LogFilter = 'all' | 'trades' | 'thinking' | 'alerts';
const FILTERS: { id: LogFilter; label: string; levels: LogLevel[] | null }[] = [
  { id: 'all', label: 'All', levels: null },
  { id: 'trades', label: 'Trades', levels: ['buy', 'sell'] },
  { id: 'thinking', label: 'Thinking', levels: ['think'] },
  { id: 'alerts', label: 'Alerts', levels: ['warn', 'error', 'info'] },
];
const KIND: Record<LogLevel, string> = { buy: 'Buy', sell: 'Sell', think: 'Thinking', info: 'Info', warn: 'Alert', error: 'Error' };

let logFilter: LogFilter = 'all';
const filterListeners = new Set<(f: LogFilter) => void>();
const setLogFilter = (f: LogFilter) => {
  logFilter = f;
  filterListeners.forEach((fn) => fn(f));
};
function useLogFilter() {
  const [f, setF] = useState(logFilter);
  useEffect(() => {
    filterListeners.add(setF);
    return () => void filterListeners.delete(setF);
  }, []);
  return f;
}

function LogTools() {
  const filter = useLogFilter();
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const exportLog = () =>
    downloadText(
      `crdtrade-log-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv([['Time', 'Type', 'Market', 'Message'], ...logs.slice().reverse().map((l) => [new Date(l.time).toISOString(), KIND[l.level], l.symbol ?? '', l.message])]),
    );
  return (
    <>
      <div className="segmented log-filters" role="group" aria-label="Filter log">
        {FILTERS.map((f) => (
          <button key={f.id} aria-pressed={filter === f.id} onClick={() => setLogFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <button className="btn btn-sm btn-icon btn-ghost" onClick={exportLog} title="Export log as CSV" aria-label="Export log as CSV" disabled={!logs.length}>
        <Icon name="download" />
      </button>
      <button className="btn btn-sm btn-icon btn-ghost" onClick={clearLogs} title="Clear log" aria-label="Clear log" disabled={!logs.length}>
        <Icon name="trash" />
      </button>
    </>
  );
}

const ActivityLog = memo(function ActivityLog() {
  const logs = useStore((s) => s.logs);
  const filter = useLogFilter();
  const levels = FILTERS.find((f) => f.id === filter)!.levels;
  const shown = useMemo(() => (levels ? logs.filter((l) => levels.includes(l.level)) : logs).slice(0, 300), [logs, levels]);

  if (!shown.length) {
    return (
      <div className="empty">
        <strong>{logs.length ? 'Nothing matches this filter' : 'The bot log is empty'}</strong>
        <p>{logs.length ? 'Choose All to see every entry.' : 'Start the bot and it will explain every buy, sell and decision to wait here.'}</p>
      </div>
    );
  }
  return (
    <ol className="log-list" aria-live="polite" aria-relevant="additions">
      {shown.map((l) => (
        <li key={l.id} className="log-item" data-level={l.level}>
          <span className="log-time num">{clock(l.time)}</span>
          <span className="log-kind" data-level={l.level}>
            {KIND[l.level]}
          </span>
          <span className="log-msg">{l.message}</span>
        </li>
      ))}
    </ol>
  );
});

