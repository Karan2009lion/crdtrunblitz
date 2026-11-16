import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { hub, type Quote } from '../market/hub';

/** Prices and feed status for every market, refreshed a few times a second. */
export function useQuotes(): Record<string, Quote> {
  return useSyncExternalStore(hub.subscribeSnapshot, hub.getSnapshot);
}

export function usePrices(): Record<string, number> {
  const quotes = useQuotes();
  return useMemo(() => {
    const out: Record<string, number> = {};
    for (const [s, q] of Object.entries(quotes)) if (q.last) out[s] = q.last;
    return out;
  }, [quotes]);
}

/** Re-renders on an interval, for countdowns and "x seconds ago". */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Css custom properties as resolved for the current theme. */
export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v('--surface'),
    text: v('--muted'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    up: v('--up'),
    down: v('--down'),
    accent: v('--accent'),
    focus: v('--focus'),
    upSoft: v('--up-soft'),
    downSoft: v('--down-soft'),
    font: v('--font'),
  };
}
