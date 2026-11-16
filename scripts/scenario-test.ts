/**
 * Scenario test: made-up but realistic 1-minute BTC prices in eight market moods (quiet, climbing,
 * choppy, crash, slow decline, pump, wild swings, recovery), run through the Live-mode bot with the
 * app's own engine, so you can see where it buys and sells and why. The AI learns alongside.
 * Seeded, so every run gives the same prices.
 *
 *   npx vite-node scripts/scenario-test.ts -- [out.json] [seed]
 */
import { writeFileSync } from 'node:fs';
import type { Candle } from '../src/types';
import { runBacktest } from '../src/engine/backtest';
import { LIVE_SETTINGS } from '../src/store/useStore';
import { createLearner, learnFromHistory, onCandleClosed } from '../src/ai/learner';
import { SCENARIOS, WARMUP, makePrices } from './lib/scenarios';

const [outPath, seedArg] = process.argv.slice(2).filter((a) => a !== '--');
const SEED = Number(seedArg ?? 42);

const candles = makePrices(SEED);
const base: Candle[] = candles.map(({ scenario: _s, ...c }) => c);
const start = base[WARMUP].time;
const settings = LIVE_SETTINGS;
const run = (fees: boolean) =>
  runBacktest({ base, start, timeframe: '1m', settings: fees ? settings : { ...settings, feePct: 0, slippagePct: 0 }, startCash: 10_000 });
const result = run(true);
const noFees = run(false);
const scenarioAt = (sec: number) => candles[Math.min(candles.length - 1, Math.max(0, Math.floor((sec - base[0].time) / 60)))].scenario;

// The AI: first trained on the opening hours, then calling each minute live.
let ai = learnFromHistory(createLearner(), base.slice(0, 900));
const aiCalls = SCENARIOS.map(() => ({ calls: 0, correct: 0 }));
for (let i = 900; i < base.length; i++) {
  const before = ai.live;
  ai = onCandleClosed(ai, base.slice(Math.max(0, i - 400), i + 1));
  if (ai.live.calls > before.calls) {
    const k = scenarioAt(ai.trainedUntil);
    aiCalls[k].calls += ai.live.calls - before.calls;
    aiCalls[k].correct += ai.live.correct - before.correct;
  }
}

const money = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;
const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
console.log(`Seed ${SEED}: ${base.length} minutes, BTC ${base[WARMUP].close.toFixed(0)} → ${base[base.length - 1].close.toFixed(0)} (${result.stats.buyHoldPct.toFixed(2)}%)`);
console.log(`Bot: ${result.trades.length} trades, ${result.stats.wins} won, ${money(result.stats.netPnl)} (${result.stats.returnPct.toFixed(2)}%), fees $${result.stats.fees.toFixed(2)}`);
console.log(`Same trades without fees: ${money(noFees.stats.netPnl)} (${noFees.stats.returnPct.toFixed(2)}%)\n`);
const rows = SCENARIOS.map((s, k) => {
  const seg = candles.filter((c) => c.scenario === k);
  const first = Math.max(seg[0].time, start);
  const startPx = base.find((c) => c.time >= first)!.open;
  const tr = result.trades.filter((t) => scenarioAt(t.entryTime / 1000) === k);
  return {
    name: s.name,
    from: seg[0].time,
    to: seg[seg.length - 1].time + 60,
    btcPct: ((seg[seg.length - 1].close - startPx) / startPx) * 100,
    trades: tr.length,
    wins: tr.filter((t) => t.pnl > 0).length,
    pnl: tr.reduce((a, t) => a + t.pnl, 0),
    ai: aiCalls[k],
  };
});
for (const r of rows)
  console.log(
    `${r.name.padEnd(16)} BTC ${r.btcPct >= 0 ? '+' : ''}${r.btcPct.toFixed(2)}%  trades ${r.trades} (won ${r.wins})  ${money(r.pnl)}  AI ${r.ai.calls ? `${((100 * r.ai.correct) / r.ai.calls).toFixed(0)}% of ${r.ai.calls}` : '–'}`,
  );
console.log('\nTrades:');
for (const t of result.trades)
  console.log(
    `  ${time(t.entryTime)} buy ${t.entryPrice.toFixed(0)} → ${time(t.exitTime)} sell ${t.exitPrice.toFixed(0)}  ${money(t.pnl)}  [${SCENARIOS[scenarioAt(t.entryTime / 1000)].name}] ${t.exitReason}`,
  );
console.log(`\nAI: right ${((100 * ai.live.correct) / ai.live.calls).toFixed(1)}% of ${ai.live.calls} live calls (first training test: ${ai.historyCheck ? ((100 * ai.historyCheck.correct) / ai.historyCheck.calls).toFixed(1) + '%' : '–'})`);

if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify({
      seed: SEED,
      candles: base.map((c) => [c.time, +c.open.toFixed(2), +c.high.toFixed(2), +c.low.toFixed(2), +c.close.toFixed(2)]),
      start,
      scenarios: rows,
      trades: result.trades.map((t) => ({ entryTime: t.entryTime, exitTime: t.exitTime, entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnl: t.pnl, pnlPct: t.pnlPct, fees: t.fees, entryReason: t.entryReason, exitReason: t.exitReason })),
      equity: result.equity,
      stats: result.stats,
      noFees: noFees.stats,
      ai: { live: ai.live, historyCheck: ai.historyCheck },
      settings: { stopAtr: settings.stopAtr, cooldownMin: settings.cooldownSec / 60, feePct: settings.feePct, slippagePct: settings.slippagePct },
    }),
  );
}
