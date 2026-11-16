import type { Candle, FeedStatus, Interval } from '../types';

/** Everything a single-market feed can report back to the hub. */
export interface FeedContext {
  symbol: string;
  interval: Interval;
  /** Replaces the market's candles (first load, and again after every reconnect to fill gaps). */
  history(candles: Candle[]): void;
  update(candle: Candle): void;
  reference(price: number): void;
  status(status: FeedStatus, note?: string): void;
}

export type StartFeed = (ctx: FeedContext) => () => void;

const BINANCE_REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
const BINANCE_WS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
/** A live stream that stays silent this long is treated as dead and reopened. */
const STALE_MS = 30_000;

type Kline = [number, string, string, string, string, string, ...unknown[]];

async function fetchJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((body && (body.msg as string)) || `HTTP ${res.status}`), { status: res.status });
  return body;
}

/**
 * Live Binance candles that never fall back to made-up prices. History and the live stream
 * retry forever with growing pauses, and history is reloaded after every reconnect so candles
 * that closed while the computer was asleep or offline are filled in.
 */
export const startBinance: StartFeed = (ctx) => {
  const abort = new AbortController();
  const s = ctx.symbol.toLowerCase();
  let ws: WebSocket | null = null;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastMsg = Date.now();
  const backoff = () => Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));

  async function loadHistory(): Promise<boolean> {
    let lastErr: unknown;
    for (const host of BINANCE_REST) {
      try {
        const [klines, ticker] = await Promise.all([
          fetchJson(`${host}/api/v3/klines?symbol=${ctx.symbol}&interval=${ctx.interval}&limit=500`, abort.signal) as Promise<Kline[]>,
          fetchJson(`${host}/api/v3/ticker/24hr?symbol=${ctx.symbol}`, abort.signal).catch(() => null),
        ]);
        if (stopped) return false;
        ctx.history(klines.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })));
        if (ticker?.openPrice) ctx.reference(+ticker.openPrice);
        return true;
      } catch (e) {
        if (stopped || abort.signal.aborted) return false;
        lastErr = e;
      }
    }
    failures++;
    ctx.status('offline', `Can't reach Binance (${(lastErr as Error)?.message ?? 'network error'}). Retrying in ${Math.round(backoff() / 1000)}s.`);
    return false;
  }

  async function start() {
    if (stopped) return;
    ctx.status('connecting');
    if (!(await loadHistory())) {
      if (!stopped) timer = setTimeout(start, backoff());
      return;
    }
    connect();
  }

  function connect() {
    if (stopped) return;
    const host = BINANCE_WS[failures % BINANCE_WS.length];
    ws = new WebSocket(`${host}/stream?streams=${s}@kline_${ctx.interval}/${s}@miniTicker`);
    ws.onopen = () => {
      failures = 0;
      lastMsg = Date.now();
      ctx.status('live');
    };
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      const msg = JSON.parse(ev.data as string);
      const d = msg.data;
      if (!d) return;
      if (d.e === 'kline') {
        const k = d.k;
        ctx.update({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
      } else if (d.e === '24hrMiniTicker') {
        ctx.reference(+d.o);
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      ws = null;
      failures++;
      ctx.status('connecting', 'Reconnecting to Binance…');
      // Reload history on the way back so nothing that closed in between is missed.
      timer = setTimeout(start, backoff());
    };
  }

  // Websockets can go silent without closing (sleep, network change); reopen if nothing arrives.
  const staleTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > STALE_MS) ws.close();
  }, 10_000);

  void start();

  return () => {
    stopped = true;
    abort.abort();
    clearTimeout(timer);
    clearInterval(staleTimer);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
};
