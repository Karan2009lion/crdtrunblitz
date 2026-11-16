import { FEATURE_COUNT, SETUP_LABEL, type Candidate, type Outcome, type SetupId } from './setups';

/**
 * The trader's memory. Every setup it sees, taken or not, is followed to its outcome, and the
 * learner (an online logistic model) is updated with it, so situations that kept losing get a
 * lower chance and stop being traded. It only ever learns from outcomes that are already known.
 */

export interface SetupStats {
  n: number;
  wins: number;
  sumR: number;
}

export interface Brain {
  w: number[];
  b: number;
  m: number[];
  v: number[];
  steps: number;
  /** Running input statistics (Welford) for standardising features. */
  count: number;
  mean: number[];
  m2: number[];
  /** Outcomes learned from. */
  learned: number;
  /** Average result of winners and losers, in units of risk. */
  avgWinR: number;
  avgLossR: number;
  /** Per setup and direction, e.g. "breakout:short". */
  stats: Record<string, SetupStats>;
}

const LR = 0.01;
const L2 = 1e-3;
const B1 = 0.9;
const B2 = 0.999;
/** Outcomes needed before the learner's view is trusted. */
export const WARM = 60;

export function createBrain(): Brain {
  return {
    w: new Array(FEATURE_COUNT).fill(0),
    b: 0,
    m: new Array(FEATURE_COUNT + 1).fill(0),
    v: new Array(FEATURE_COUNT + 1).fill(0),
    steps: 0,
    count: 0,
    mean: new Array(FEATURE_COUNT).fill(0),
    m2: new Array(FEATURE_COUNT).fill(0),
    learned: 0,
    avgWinR: 1.8,
    avgLossR: 1.1,
    stats: {},
  };
}

function standardise(br: Brain, x: number[]): number[] {
  return x.map((v, i) => {
    const sd = br.count > 1 ? Math.sqrt(br.m2[i] / (br.count - 1)) : 1;
    return sd > 1e-9 ? (v - br.mean[i]) / sd : 0;
  });
}

/** Chance (0–1) that a setup ends in profit after fees. */
export function winChance(br: Brain, x: number[]): number {
  const z = standardise(br, x);
  let s = br.b;
  for (let i = 0; i < z.length; i++) s += br.w[i] * z[i];
  return 1 / (1 + Math.exp(-s));
}

/** Expected result in units of risk, from the chance and the average win and loss so far. */
export const expectedR = (br: Brain, p: number) => p * br.avgWinR - (1 - p) * br.avgLossR;

/** Learns from one finished setup. Mutates and returns the brain. */
export function learn(br: Brain, c: Candidate, o: Outcome): Brain {
  const x = c.features;
  // Fold the inputs into the running statistics first.
  br.count++;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - br.mean[i];
    br.mean[i] += d / br.count;
    br.m2[i] += d * (x[i] - br.mean[i]);
  }
  const y = o.r > 0 ? 1 : 0;
  const z = standardise(br, x);
  const p = winChance(br, x);
  const g = p - y;
  br.steps++;
  const c1 = 1 - B1 ** br.steps;
  const c2 = 1 - B2 ** br.steps;
  const step = (k: number, grad: number) => {
    br.m[k] = B1 * br.m[k] + (1 - B1) * grad;
    br.v[k] = B2 * br.v[k] + (1 - B2) * grad * grad;
    return (LR * (br.m[k] / c1)) / (Math.sqrt(br.v[k] / c2) + 1e-8);
  };
  for (let i = 0; i < z.length; i++) br.w[i] -= step(i, g * z[i] + L2 * br.w[i]);
  br.b -= step(z.length, g);
  // Average sizes of wins and losses, slowly updated.
  const k = Math.min(0.02, 1 / (br.learned + 1));
  if (o.r > 0) br.avgWinR += (o.r - br.avgWinR) * Math.max(k, 0.005);
  else br.avgLossR += (-o.r - br.avgLossR) * Math.max(k, 0.005);
  br.learned++;
  const key = `${c.setup}:${c.side}`;
  const st = (br.stats[key] ??= { n: 0, wins: 0, sumR: 0 });
  st.n++;
  st.wins += y;
  st.sumR += o.r;
  return br;
}

/** Plain-language lessons: which setups have paid and which haven't. */
export function lessons(br: Brain): { text: string; good: boolean; n: number }[] {
  return Object.entries(br.stats)
    .filter(([, s]) => s.n >= 10)
    .map(([key, s]) => {
      const [setup, side] = key.split(':') as [SetupId, 'long' | 'short'];
      const avg = s.sumR / s.n;
      const what = `${side === 'long' ? 'Buying' : 'Selling short'} on a ${SETUP_LABEL[setup]}`;
      return {
        n: s.n,
        good: avg > 0,
        text: `${what}: won ${Math.round((100 * s.wins) / s.n)}% of ${s.n}, average ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}× the risk${avg > 0 ? '' : ' (now taken only when the chart looks better than usual)'}`,
      };
    })
    .sort((a, b) => b.n - a.n);
}
