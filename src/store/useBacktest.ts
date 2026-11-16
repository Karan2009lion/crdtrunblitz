import { create } from 'zustand';
import type { Candle } from '../types';
import type { BacktestResult } from '../engine/backtest';
import { WARMUP_BARS } from '../engine/backtest';
import type { WorkerRequest } from '../engine/worker';
import { fetchBinanceMinutes } from '../market/history';
import { SYMBOL, botSpec, settingsFor, startCash, useStore } from './useStore';

/** Backtests start with the same paper money as the live account. */
export const backtestCash = () => startCash(useStore.getState().account);
/** Replay length in seconds of real time; 0 shows the result at once. */
export const SPEEDS = [
  { seconds: 0, label: 'Instant' },
  { seconds: 60, label: '1 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 1200, label: '20 min' },
];

export interface Dataset {
  base: Candle[];
  start: number;
  end: number;
}

interface BacktestState {
  days: number;
  speed: number;

  status: 'idle' | 'loading' | 'running' | 'replaying' | 'done' | 'error';
  message: string;
  progress: number;
  data: Dataset | null;
  result: BacktestResult | null;
  /** Unix seconds revealed so far during a replay. */
  cursor: number;
  paused: boolean;

  set(patch: Partial<BacktestState>): void;
}

export const useBacktest = create<BacktestState>()((set) => ({
  days: 30,
  speed: 0,
  status: 'idle',
  message: '',
  progress: 0,
  data: null,
  result: null,
  cursor: 0,
  paused: false,
  set: (patch) => set(patch),
}));

/* ------------------------------------------------------------------ worker */

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

function call<T>(req: Omit<WorkerRequest, 'id'>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data as { id: number; type: string; result?: unknown; message?: string };
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.result);
      else p.reject(new Error(m.message));
    };
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ ...req, id });
  });
}

/* ------------------------------------------------------------------ actions */

const get = useBacktest.getState;

/** 1-minute BTC candles for the chosen window plus warm-up for the strategy's signals. Real Binance prices only. */
async function loadData(): Promise<Dataset> {
  const s = get();
  const end = Math.floor(Date.now() / 60000) * 60;
  const start = end - s.days * 86400;
  const { barSec } = botSpec(useStore.getState().controls);
  // The 1-minute chart reader looks back 4 hours (240 candles), so give it a longer warm-up.
  const from = start - (barSec < 3600 ? Math.max(WARMUP_BARS, 300) : WARMUP_BARS) * barSec;
  const base = await fetchBinanceMinutes(SYMBOL, from, end, (d, t) => s.set({ progress: d / t, message: `Downloading BTC price history… ${Math.round((d / t) * 100)}%` }));
  return { base, start, end };
}

export async function runBacktestNow() {
  const s = get();
  s.set({ status: 'loading', message: 'Loading price history…', progress: 0, result: null, paused: false });
  try {
    const data = await loadData();
    get().set({ data, status: 'running', message: 'The bot is trading through the history…' });
    const { account, controls } = useStore.getState();
    const spec = botSpec(controls);
    // Your settings from the Profile screen, as paper trading uses them (the loss limit aside).
    const settings = { ...settingsFor(account, controls, 'paper'), maxLoss: 0 };
    const cash = startCash(account);
    const result = await call<BacktestResult>({
      type: 'run',
      input: { base: data.base, start: data.start, end: data.end, timeframe: spec.interval, settings, startCash: cash },
    });
    const speed = get().speed;
    get().set({ result, status: speed ? 'replaying' : 'done', cursor: speed ? data.start : data.end, message: '' });
  } catch (e) {
    get().set({ status: 'error', message: `Couldn't download BTC prices from Binance (${(e as Error).message}). Check your internet connection and try again.` });
  }
}
