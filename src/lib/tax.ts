import type { Trade } from '../types';
import type { Controls } from '../store/useStore';

/** India: 30% tax on crypto gains plus 4% cess on the tax; losses can't reduce it. */
export const INDIA_RATE = 0.3 * 1.04;
/** India: 1% TDS is withheld on each sale. It counts toward the tax, and any extra is refunded when you file. */
export const INDIA_TDS = 0.01;

export interface Ledger {
  /** What the trades made before fees. */
  gross: number;
  fees: number;
  /** After fees: what the account actually gained. */
  net: number;
  tax: number;
  /** India only: withheld on sales, part of the tax rather than an extra cost. */
  tds: number;
  /** What is left after fees and tax, from the trades alone. */
  afterTax: number;
  explain: string;
}

/** Fees and an estimate of the tax on finished trades. Not tax advice. */
export function ledger(trades: Trade[], c: Pick<Controls, 'tax' | 'taxPct'>): Ledger {
  const gross = trades.reduce((s, t) => s + t.pnl + t.fees, 0);
  const fees = trades.reduce((s, t) => s + t.fees, 0);
  const net = gross - fees;
  let tax = 0;
  let tds = 0;
  let explain = 'No tax is taken off.';
  if (c.tax === 'india') {
    // Each winning trade is taxed on its gain; fees can't be deducted, and losing trades don't offset it.
    tax = trades.reduce((s, t) => s + Math.max(0, t.pnl + t.fees), 0) * INDIA_RATE;
    tds = trades.filter((t) => t.side === 'long').reduce((s, t) => s + t.qty * t.exitPrice, 0) * INDIA_TDS;
    explain = '31.2% (30% tax plus 4% cess) on the gain of each winning trade. Fees can’t be deducted and losing trades don’t reduce it.';
  } else if (c.tax === 'flat') {
    tax = Math.max(0, net) * (c.taxPct / 100);
    explain = `${c.taxPct}% of the total profit after fees, once losses are taken off.`;
  }
  return { gross, fees, net, tax, tds, afterTax: net - tax, explain };
}
