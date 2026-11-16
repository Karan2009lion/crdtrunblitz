import type { Candle, FeedStatus, Interval, Market } from '../types';
import { startBinance } from './feeds';

const MAX_BARS = 1000;

export interface MarketState {
  candles: Candle[];
  status: FeedStatus;
  note?: string;
  reference?: number;
  last?: number;
  /** When the last live update arrived. */
  updatedAt?: number;
}

/** What the UI needs about a market, refreshed a few times a second. */
export interface Quote {
  status: FeedStatus;
  note?: string;
  reference?: number;
  last?: number;
  bars: number;
  updatedAt?: number;
}

/** Fired on every price update. `closed` is the bar that just finished, if a new one started. */
type BarListener = (symbol: string, candles: Candle[], closed: Candle | null) => void;

/** Owns live market data feeds at one candle interval. */
export class MarketHub {
  private interval: Interval;
  private feeds = new Map<string, () => void>();
  private state = new Map<string, MarketState>();
  private barListeners = new Set<BarListener>();
  private symbolListeners = new Map<string, Set<(full: boolean) => void>>();

  // Throttled snapshot for React (prices, statuses), so the UI doesn't re-render per tick.
  private snapshot: Record<string, Quote> = {};
  private snapshotListeners = new Set<() => void>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(interval: Interval) {
    this.interval = interval;
  }

  sync(markets: Market[], interval: Interval = this.interval) {
    const restartAll = interval !== this.interval;
    this.interval = interval;
    const wanted = new Set(markets.map((m) => m.symbol));
    for (const symbol of [...this.feeds.keys()]) {
      if (restartAll || !wanted.has(symbol)) this.stopFeed(symbol, !wanted.has(symbol));
    }
    for (const m of markets) if (!this.feeds.has(m.symbol)) this.startFeed(m.symbol);
    this.markDirty();
  }

  private startFeed(symbol: string) {
    const prev = this.state.get(symbol);
    this.state.set(symbol, { candles: [], status: 'connecting', last: prev?.last });
    let alive = true;
    const stop = startBinance({
      symbol,
      interval: this.interval,
      history: (candles) => alive && this.onHistory(symbol, candles),
      update: (c) => alive && this.onUpdate(symbol, c),
      reference: (p) => {
        if (!alive) return;
        this.state.get(symbol)!.reference = p;
        this.markDirty();
      },
      status: (status, note) => {
        if (!alive) return;
        const st = this.state.get(symbol)!;
        st.status = status;
        st.note = note;
        this.markDirty();
      },
    });
    this.feeds.set(symbol, () => {
      alive = false;
      stop();
    });
  }

  private stopFeed(symbol: string, forget: boolean) {
    this.feeds.get(symbol)?.();
    this.feeds.delete(symbol);
    if (forget) this.state.delete(symbol);
  }

  private onHistory(symbol: string, history: Candle[]) {
    const st = this.state.get(symbol)!;
    // History wins for the bars it covers; keep any newer live bars that arrived meanwhile.
    const lastHist = history.length ? history[history.length - 1].time : -Infinity;
    st.candles = [...history, ...st.candles.filter((c) => c.time > lastHist)].slice(-MAX_BARS);
    st.last = st.candles[st.candles.length - 1]?.close ?? st.last;
    this.notifySymbol(symbol, true);
    this.markDirty();
  }

  private onUpdate(symbol: string, c: Candle) {
    const st = this.state.get(symbol)!;
    const bars = st.candles;
    const tail = bars[bars.length - 1];
    let closed: Candle | null = null;
    if (!tail || c.time > tail.time) {
      closed = tail ?? null;
      bars.push(c);
      if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
    } else if (c.time === tail.time) {
      bars[bars.length - 1] = c;
    } else {
      return;
    }
    st.last = c.close;
    st.updatedAt = Date.now();
    this.barListeners.forEach((fn) => fn(symbol, bars, closed));
    this.notifySymbol(symbol, false);
    this.markDirty();
  }

  private notifySymbol(symbol: string, full: boolean) {
    this.symbolListeners.get(symbol)?.forEach((fn) => fn(full));
  }

  private markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      const next: Record<string, Quote> = {};
      for (const [s, st] of this.state)
        next[s] = { status: st.status, note: st.note, reference: st.reference, last: st.last, bars: st.candles.length, updatedAt: st.updatedAt };
      this.snapshot = next;
      this.snapshotListeners.forEach((fn) => fn());
    }, 350);
  }

  /* ------------------------------------------------------------ public reads */

  candles(symbol: string): Candle[] {
    return this.state.get(symbol)?.candles ?? [];
  }

  price(symbol: string): number | undefined {
    return this.state.get(symbol)?.last;
  }

  status(symbol: string): MarketState | undefined {
    return this.state.get(symbol);
  }

  getInterval() {
    return this.interval;
  }

  onBar(fn: BarListener) {
    this.barListeners.add(fn);
    return () => void this.barListeners.delete(fn);
  }

  /** Per-tick updates for one market. `full` means the history was (re)loaded. */
  watch(symbol: string, fn: (full: boolean) => void) {
    if (!this.symbolListeners.has(symbol)) this.symbolListeners.set(symbol, new Set());
    this.symbolListeners.get(symbol)!.add(fn);
    return () => void this.symbolListeners.get(symbol)?.delete(fn);
  }

  subscribeSnapshot = (fn: () => void) => {
    this.snapshotListeners.add(fn);
    return () => void this.snapshotListeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;
}

/** Candles for the chart, at whatever interval the chart shows. */
export const hub = new MarketHub('4h');
/** The bot's own 4-hour candles, independent of the chart. */
export const botHub = new MarketHub('4h');
