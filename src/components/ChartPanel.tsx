import { useEffect, useRef, useState } from 'react';
import { MARKET, SYMBOL, TIMEFRAMES, useStore } from '../store/useStore';
import { useQuotes } from '../hooks/useMarket';
import { INTERVALS } from '../lib/markets';
import { pct, price as fmtPrice, signedMoney } from '../lib/format';
import { unrealized } from '../engine/broker';
import type { FeedStatus } from '../types';
import { BotChart } from './BotChart';
import { TradingViewWidget } from './TradingViewWidget';

const STATUS_TEXT: Record<FeedStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  simulated: 'Simulated prices',
  waiting: 'Waiting for trades',
  offline: 'No connection',
};

export function ChartPanel() {
  const interval = useStore((s) => s.interval);
  const setInterval = useStore((s) => s.setInterval);
  const view = useStore((s) => s.chartView);
  const setView = useStore((s) => s.setChartView);
  const theme = useStore((s) => s.theme);
  const position = useStore((s) => s.positions[0]);
  const candle = useStore((s) => TIMEFRAMES[s.controls.timeframe].candle);
  const quotes = useQuotes();
  const q = quotes[SYMBOL];
  const last = q?.last;
  const chg = last && q?.reference ? ((last - q.reference) / q.reference) * 100 : 0;

  // Flash the price colour on change.
  const prevPrice = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (last && prevPrice.current && last !== prevPrice.current) setFlash(last > prevPrice.current ? 'flash-up' : 'flash-down');
    prevPrice.current = last;
  }, [last]);

  const pnl = position && last ? unrealized(position, last) - position.entryFee : 0;

  return (
    <section className="panel area-chart" aria-label="BTC/USDT chart">
      <div className="chart-head">
        <div className="chart-title">
          <h1>
            BTC/USDT
            <span className="name">Bitcoin</span>
          </h1>
          <span className={`big-price ${flash}`}>{last ? fmtPrice(last) : '—'}</span>
          <span className={`num ${chg > 0 ? 'up' : chg < 0 ? 'down' : 'muted'}`}>{last ? `${pct(chg)} 24h` : ''}</span>
          <span className="feed-pill" title={q?.note}>
            <span className="feed-dot" data-status={q?.status ?? 'connecting'} />
            {STATUS_TEXT[q?.status ?? 'connecting']}
          </span>
          {position && (
            <span className="feed-pill">
              <span className="side-tag" data-side={position.side}>
                {position.side === 'long' ? 'Long' : 'Short'}
              </span>
              <span className={pnl >= 0 ? 'up' : 'down'}>{signedMoney(pnl)}</span>
            </span>
          )}
        </div>

        <div className="chart-tools">
          <div className="segmented" role="group" aria-label="Chart timeframe" title={`Changes the chart only. The bot trades ${candle} candles.`}>
            {INTERVALS.map((iv) => (
              <button key={iv.id} aria-pressed={interval === iv.id} onClick={() => setInterval(iv.id)} title={`${iv.label} candles (chart only)`}>
                {iv.label}
              </button>
            ))}
          </div>
          <div className="segmented" role="tablist" aria-label="Chart view">
            <button role="tab" aria-selected={view === 'bot'} onClick={() => setView('bot')}>
              Bot view
            </button>
            <button role="tab" aria-selected={view === 'tradingview'} onClick={() => setView('tradingview')}>
              TradingView
            </button>
          </div>
        </div>
      </div>

      {view === 'bot' ? (
        <BotChart symbol={SYMBOL} emptyText={q?.status === 'offline' ? (q.note ?? 'No connection to Binance') : 'Loading candles…'} />
      ) : (
        <TradingViewWidget tv={MARKET.tv} interval={interval} theme={theme} />
      )}
    </section>
  );
}
