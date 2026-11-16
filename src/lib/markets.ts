import type { Interval } from '../types';

export const INTERVALS: { id: Interval; label: string; seconds: number; tv: string }[] = [
  { id: '1s', label: '1s', seconds: 1, tv: '1' },
  { id: '1m', label: '1m', seconds: 60, tv: '1' },
  { id: '5m', label: '5m', seconds: 300, tv: '5' },
  { id: '15m', label: '15m', seconds: 900, tv: '15' },
  { id: '30m', label: '30m', seconds: 1800, tv: '30' },
  { id: '1h', label: '1h', seconds: 3600, tv: '60' },
  { id: '4h', label: '4h', seconds: 14400, tv: '240' },
];

export function intervalSeconds(iv: Interval): number {
  return INTERVALS.find((i) => i.id === iv)!.seconds;
}

export function displaySymbol(symbol: string): string {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol;
}
