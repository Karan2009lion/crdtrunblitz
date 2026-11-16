/**
 * A small neural network (one hidden layer) that outputs the chance BTC is higher in 15 minutes.
 * Trained with Adam on log loss, one sample at a time, so it can keep learning in the browser.
 * Inputs are standardised with running means and variances learned alongside the weights.
 */

export interface NetState {
  inputs: number;
  hidden: number;
  w1: number[]; // hidden × inputs
  b1: number[];
  w2: number[]; // hidden
  b2: number;
  /** Adam moments, same shapes flattened: w1, b1, w2, b2. */
  m: number[];
  v: number[];
  steps: number;
  /** Running input statistics (Welford). */
  count: number;
  mean: number[];
  m2: number[];
}

const LR = 0.002;
const L2 = 1e-4;
const B1 = 0.9;
const B2 = 0.999;

/** Small seeded random numbers, so a fresh network is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

export function createNet(inputs: number, hidden = 16, seed = 7): NetState {
  const rand = rng(seed);
  const scale1 = Math.sqrt(2 / inputs);
  const scale2 = Math.sqrt(2 / hidden);
  const size = hidden * inputs + hidden + hidden + 1;
  return {
    inputs,
    hidden,
    w1: Array.from({ length: hidden * inputs }, () => rand() * 2 * scale1),
    b1: new Array(hidden).fill(0),
    w2: Array.from({ length: hidden }, () => rand() * 2 * scale2),
    b2: 0,
    m: new Array(size).fill(0),
    v: new Array(size).fill(0),
    steps: 0,
    count: 0,
    mean: new Array(inputs).fill(0),
    m2: new Array(inputs).fill(0),
  };
}

function standardise(net: NetState, x: ArrayLike<number>): Float64Array {
  const z = new Float64Array(net.inputs);
  for (let i = 0; i < net.inputs; i++) {
    const sd = net.count > 1 ? Math.sqrt(net.m2[i] / (net.count - 1)) : 1;
    z[i] = sd > 1e-9 ? (x[i] - net.mean[i]) / sd : 0;
  }
  return z;
}

function forward(net: NetState, z: Float64Array) {
  const h = new Float64Array(net.hidden);
  let out = net.b2;
  for (let j = 0; j < net.hidden; j++) {
    let s = net.b1[j];
    const row = j * net.inputs;
    for (let i = 0; i < net.inputs; i++) s += net.w1[row + i] * z[i];
    h[j] = Math.tanh(s);
    out += net.w2[j] * h[j];
  }
  return { h, p: 1 / (1 + Math.exp(-out)) };
}

/** Chance (0–1) that the price is higher at the horizon. */
export function predict(net: NetState, x: ArrayLike<number>): number {
  return forward(net, standardise(net, x)).p;
}

/** Folds a new input row into the running statistics. */
export function observe(net: NetState, x: ArrayLike<number>) {
  net.count++;
  for (let i = 0; i < net.inputs; i++) {
    const d = x[i] - net.mean[i];
    net.mean[i] += d / net.count;
    net.m2[i] += d * (x[i] - net.mean[i]);
  }
}

/** One Adam step on one labelled example. Returns its log loss before the step. */
export function train(net: NetState, x: ArrayLike<number>, y: 0 | 1): number {
  const z = standardise(net, x);
  const { h, p } = forward(net, z);
  const dOut = p - y;
  const { inputs, hidden } = net;
  const grad = new Float64Array(net.m.length);
  // Layout: w1 (hidden*inputs), b1 (hidden), w2 (hidden), b2 (1).
  const oB1 = hidden * inputs;
  const oW2 = oB1 + hidden;
  const oB2 = oW2 + hidden;
  for (let j = 0; j < hidden; j++) {
    grad[oW2 + j] = dOut * h[j] + L2 * net.w2[j];
    const dh = dOut * net.w2[j] * (1 - h[j] * h[j]);
    grad[oB1 + j] = dh;
    const row = j * inputs;
    for (let i = 0; i < inputs; i++) grad[row + i] = dh * z[i] + L2 * net.w1[row + i];
  }
  grad[oB2] = dOut;

  net.steps++;
  const c1 = 1 - B1 ** net.steps;
  const c2 = 1 - B2 ** net.steps;
  const step = (k: number) => {
    net.m[k] = B1 * net.m[k] + (1 - B1) * grad[k];
    net.v[k] = B2 * net.v[k] + (1 - B2) * grad[k] * grad[k];
    return (LR * (net.m[k] / c1)) / (Math.sqrt(net.v[k] / c2) + 1e-8);
  };
  for (let k = 0; k < oB1; k++) net.w1[k] -= step(k);
  for (let j = 0; j < hidden; j++) net.b1[j] -= step(oB1 + j);
  for (let j = 0; j < hidden; j++) net.w2[j] -= step(oW2 + j);
  net.b2 -= step(oB2);
  const pc = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}
