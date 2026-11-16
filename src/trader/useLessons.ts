import { create } from 'zustand';
import type { BotSettings, Candle } from '../types';
import type { Timeframe } from '../store/useStore';
import { fetchBinanceKlines } from '../market/history';
import { createLessons, learnFromHistory, readChart, situationAt, type Lessons, type SignalOutcome, type Situation } from './lessons';
import { trainBrain, type Brain } from './brain';

const BAR: Record<Timeframe, number> = { '1m': 60, '15m': 900, '1h': 3600, '4h': 14_400 };
/** Days of history to learn from, per candle size. */
const DAYS: Record<Timeframe, number> = { '1m': 10, '15m': 180, '1h': 730, '4h': 730 };
/** 1-minute candles close every minute; relearning that often would be wasted work. */
const MIN_GAP_MS: Record<Timeframe, number> = { '1m': 10 * 60_000, '15m': 0, '1h': 0, '4h': 0 };

/**
 * What the bot has learned from the chart, on the candles it decides on: every momentum signal
 * in the history, taken or not, followed to its stop or target. From those results it keeps the
 * lessons by situation and trains its neural network. Rebuilt as new candles close, and on every
 * start; not saved.
 */
interface LearningState {
  timeframe: Timeframe | null;
  lessons: Lessons;
  outcomes: SignalOutcome[];
  brain: Brain | null;
  /** Unix seconds: the history learned from. */
  from: number;
  to: number;
  key: string;
  builtAt: number;
  status: 'idle' | 'loading' | 'ready' | 'offline';
}

export const useLessons = create<LearningState>(() => ({
  timeframe: null,
  lessons: createLessons(),
  outcomes: [],
  brain: null,
  from: 0,
  to: 0,
  key: '',
  builtAt: 0,
  status: 'idle',
}));

const older: Partial<Record<Timeframe, Candle[]>> = {};
const loading: Partial<Record<Timeframe, Promise<void>>> = {};

/**
 * Relearns from the closed candles (oldest first) if new ones have closed since last time. The
 * first time for a candle size, it also downloads older history to learn from.
 */
export async function refreshLessons(closedBars: Candle[], st: BotSettings, tf: Timeframe): Promise<void> {
  const sec = BAR[tf];
  if (closedBars.length > 1 && closedBars[1].time - closedBars[0].time !== sec) return; // candles of another size
  if (!older[tf] && !loading[tf]) {
    const now = Math.floor(Date.now() / 1000);
    if (useLessons.getState().timeframe !== tf) useLessons.setState({ status: 'loading' });
    loading[tf] = fetchBinanceKlines('BTCUSDT', tf, now - DAYS[tf] * 86_400, now)
      .then((bars) => void (older[tf] = bars.filter((b) => b.time + sec <= now)))
      .catch(() => void useLessons.setState({ status: 'offline' }))
      .finally(() => void delete loading[tf]);
  }
  if (loading[tf]) await loading[tf];
  const first = closedBars[0]?.time ?? Infinity;
  const bars = [...(older[tf] ?? []).filter((b) => b.time < first), ...closedBars];
  const last = bars[bars.length - 1];
  const key = `${tf}:${last?.time}:${bars.length}`;
  const s = useLessons.getState();
  if (!last || bars.length < 260 || key === s.key) return;
  if (s.timeframe === tf && Date.now() - s.builtAt < MIN_GAP_MS[tf]) return;
  const reading = readChart(bars, st);
  const { lessons, outcomes } = learnFromHistory(bars, st, reading);
  const brain = trainBrain(bars, outcomes, sec);
  useLessons.setState({ timeframe: tf, lessons, outcomes, brain, from: bars[0].time, to: last.time + sec, key, builtAt: Date.now(), status: 'ready' });
}

/** The situation a trade opened now, on the last closed candle, would be in. */
export function situationNow(closedBars: Candle[], st: BotSettings, side: 'long' | 'short'): Situation | undefined {
  if (closedBars.length < 60) return undefined;
  const bars = closedBars.slice(-300);
  return situationAt(bars, readChart(bars, st), bars.length - 1, side);
}
