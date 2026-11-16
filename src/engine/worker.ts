import { runBacktest, type BacktestInput } from './backtest';

/** Backtests run here so the page stays responsive. */

export type WorkerRequest = { id: number; type: 'run'; input: BacktestInput };

const post = (msg: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, input } = e.data;
  try {
    post({ id, type: 'result', result: runBacktest(input) });
  } catch (err) {
    post({ id, type: 'error', message: (err as Error).message });
  }
};
