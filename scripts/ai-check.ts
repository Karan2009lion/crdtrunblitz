/**
 * Replays the app's AI exactly as it runs live: first training on 7 days of 1-minute BTC candles,
 * then one closed minute at a time, calling "higher in 15 minutes?" and checking each call later.
 * Compares it with simple guesses so its accuracy has context.
 *
 *   DATA=BTCUSDT.csv DAYS=30 npx vite-node scripts/ai-check.ts
 */
import { readFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { createLearner, learnFromHistory, onCandleClosed } from '../src/ai/learner';
import { HORIZON_MIN } from '../src/ai/features';

const base: Candle[] = readFileSync(process.env.DATA!, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => {
  const [time, open, high, low, close, volume] = l.split(',').map(Number);
  return { time, open, high, low, close, volume };
});
const days = Number(process.env.DAYS ?? 30);
const end = base.length;
const start = end - days * 1440;
const warm = start - 7 * 1440;

let s = learnFromHistory(createLearner(), base.slice(warm, start));
console.log(`History check after first training: ${s.historyCheck!.correct}/${s.historyCheck!.calls} = ${((100 * s.historyCheck!.correct) / s.historyCheck!.calls).toFixed(1)}%`);
const t0 = Date.now();
for (let i = start; i < end; i++) s = onCandleClosed(s, base.slice(i - 400, i + 1));
const live = (100 * s.live.correct) / s.live.calls;

// Simple guesses over the same minutes.
let up = 0;
let follow = 0;
let n = 0;
for (let i = start; i + HORIZON_MIN < end; i++) {
  const y = base[i + HORIZON_MIN].close > base[i].close;
  up += y ? 1 : 0;
  follow += (base[i].close > base[i - HORIZON_MIN].close) === y ? 1 : 0;
  n++;
}
console.log(`Replayed ${days} days in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`AI real-time calls: ${s.live.correct}/${s.live.calls} = ${live.toFixed(1)}%`);
console.log(`Always guess "higher": ${((100 * up) / n).toFixed(1)}%`);
console.log(`Guess "same direction as the last 15 minutes": ${((100 * follow) / n).toFixed(1)}%`);
