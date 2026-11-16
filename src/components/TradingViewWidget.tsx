import { memo, useEffect, useRef } from 'react';
import type { Interval, Theme } from '../types';
import { INTERVALS } from '../lib/markets';

/** TradingView's official Advanced Chart embed, for deeper analysis with its full toolset. */
export const TradingViewWidget = memo(function TradingViewWidget({ tv, interval, theme }: { tv: string; interval: Interval; theme: Theme }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tv,
      interval: INTERVALS.find((i) => i.id === interval)?.tv ?? '1',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
      theme,
      style: '1',
      locale: 'en',
      allow_symbol_change: false,
      hide_side_toolbar: false,
      withdateranges: true,
      details: false,
      calendar: false,
      backgroundColor: theme === 'dark' ? '#141c30' : '#ffffff',
      gridColor: theme === 'dark' ? 'rgba(36, 48, 82, 0.6)' : 'rgba(224, 229, 239, 0.8)',
      studies: ['STD;EMA', 'STD;RSI'],
      support_host: 'https://www.tradingview.com',
    });
    el.firstElementChild!.appendChild(script);
    return () => {
      el.innerHTML = '';
    };
  }, [tv, interval, theme]);

  return (
    <div className="chart-body">
      <div className="tv-frame" ref={host} />
    </div>
  );
});
