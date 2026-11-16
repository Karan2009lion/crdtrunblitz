const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Account amounts are kept in USDT; a rupee account shows them converted at its fixed rate. */
let display = { format: usd, rate: 1 };
export function setMoneyDisplay(currency: 'USD' | 'INR', rate: number) {
  display = currency === 'INR' ? { format: inr, rate } : { format: usd, rate: 1 };
}

/** Multiplier from USDT to the displayed currency, for charts. */
export const displayRate = () => display.rate;

export function money(n: number): string {
  return display.format.format((Number.isFinite(n) ? n : 0) * display.rate);
}

export function signedMoney(n: number): string {
  const s = money(Math.abs(n));
  if (Math.abs(n) < 0.005) return s;
  return n > 0 ? `+${s}` : `−${s}`;
}

export function pct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0.00%';
  const s = `${Math.abs(n).toFixed(digits)}%`;
  if (Math.abs(n) < 0.5 * 10 ** -digits) return s;
  return n > 0 ? `+${s}` : `−${s}`;
}

/** Decimals that keep about five significant digits for a price. */
export function priceDecimals(p: number): number {
  if (!p || !Number.isFinite(p)) return 2;
  if (p >= 1000) return 2;
  if (p >= 1) return Math.max(2, 4 - Math.floor(Math.log10(p)));
  return Math.min(8, 4 - Math.floor(Math.log10(p)));
}

export function price(p: number): string {
  const d = priceDecimals(p);
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function qty(q: number): string {
  if (q >= 1000) return q.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (q >= 1) return q.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return q.toLocaleString('en-US', { maximumSignificantDigits: 5 });
}

export function clock(ms: number, seconds = true): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined });
}

export function dateTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? clock(ms) : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(ms, false)}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

let counter = 0;
export function uid(): string {
  counter = (counter + 1) % 1e6;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : String(c))).join(','))
    .join('\n');
}

export function downloadText(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
