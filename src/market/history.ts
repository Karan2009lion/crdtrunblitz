import type { Candle } from '../types';

/** Loads candle history from Binance for backtests and for catching up after time offline. */

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const cache = new Map<string, Candle[]>();

export async function fetchBinanceMinutes(
  symbol: string,
  startSec: number,
  endSec: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Candle[]> {
  return fetchBinanceKlines(symbol, '1m', startSec, endSec, onProgress, signal);
}

const STEP: Record<string, number> = { '1m': 60, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };

/** Candles of any Binance interval between two times, 1,000 per request. */
export async function fetchBinanceKlines(
  symbol: string,
  interval: '1m' | '15m' | '1h' | '4h' | '1d',
  startSec: number,
  endSec: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const key = `${symbol}:${interval}:${startSec}:${endSec}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const total = Math.ceil((endSec - startSec) / STEP[interval]);
  const out: Candle[] = [];
  let cursor = startSec * 1000;
  let hostIdx = 0;
  while (cursor < endSec * 1000) {
    const url = `${HOSTS[hostIdx]}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${cursor}&endTime=${endSec * 1000 - 1}`;
    let rows: [number, string, string, string, string, string][];
    try {
      const res = await fetch(url, { signal });
      if (res.status === 400) throw Object.assign(new Error(`${symbol} is not listed on Binance`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rows = await res.json();
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || signal?.aborted || ++hostIdx >= HOSTS.length) throw e;
      continue;
    }
    if (!rows.length) break;
    for (const k of rows) out.push({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    cursor = rows[rows.length - 1][0] + STEP[interval] * 1000;
    onProgress?.(out.length, total);
  }
  if (!out.length) throw new Error(`Binance returned no candles for ${symbol}`);
  cache.set(key, out);
  return out;
}
