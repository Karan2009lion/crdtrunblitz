import { useEffect, useId, useMemo, useState } from 'react';
import { botSpec, checkControls, describeHours, FALLBACK_INR_RATE, startCash, startLabel, SYMBOL, TIMEFRAMES, useStore, type Controls, type TaxSystem, type Timeframe, type TradingMode } from '../store/useStore';
import { useQuotes } from '../hooks/useMarket';
import { accountValue } from '../engine/bot';
import { unrealized } from '../engine/broker';
import { syncRealCash } from '../engine/realOrders';
import { connectReal, disconnectReal, refreshReal, useReal } from '../real/useReal';
import { dateTime, money, pct, signedMoney } from '../lib/format';
import { ledger, INDIA_TDS } from '../lib/tax';
import { describeSituation, lessonVerdict, lossCause, LESSON_MIN, shrunkAverage, type Situation } from '../trader/lessons';
import { useLessons } from '../trader/useLessons';
import { BRAIN_INPUTS, BRAIN_WARMUP, TRUST_AVG, TRUST_MIN, trusted } from '../trader/brain';
import { TestRecord } from './TestRecord';

const MODE_LABEL: Record<TradingMode, string> = { paper: 'Paper money', testnet: 'Binance Testnet', live: 'Real money' };

export function ProfileView() {
  useEffect(() => {
    void refreshReal().then(() => syncRealCash());
  }, []);
  return (
    <main className="profile">
      <div className="profile-inner">
        <header className="profile-head">
          <h1>Profile</h1>
          <p className="hint">Your money after fees and tax, the bot's settings, what it has learned, and real trading with Binance.</p>
        </header>
        <div className="profile-grid">
          <Money />
          <BotSettings />
          <NeuralNetwork />
          <Lessons />
          <section className="panel profile-card wide" aria-labelledby="h-record">
            <div className="card-head">
              <h2 id="h-record">Test record</h2>
            </div>
            <TestRecord />
          </section>
          <HowItTrades />
          <RealTrading />
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------ money, fees and tax */

const TAX_LABEL: Record<TaxSystem, string> = { none: 'None', india: 'India (crypto)', flat: 'Flat rate' };

function Money() {
  const tradingMode = useStore((s) => s.tradingMode);
  const account = useStore((s) => s.account);
  const cash = useStore((s) => s.cash);
  const test = useStore((s) => s.test);
  const trades = useStore((s) => s.trades);
  const position = useStore((s) => s.positions[0]);
  const controls = useStore((s) => s.controls);
  const setControls = useStore((s) => s.setControls);
  const real = useReal();
  const px = useQuotes()[SYMBOL]?.last;
  const eq = accountValue(px);
  const start = test?.startEquity ?? (tradingMode === 'paper' ? startCash(account) : eq);
  const l = useMemo(() => ledger(trades, controls), [trades, controls]);
  const open = position && px ? unrealized(position, px) - position.entryFee : 0;
  const keep = start + l.afterTax + open;
  const [rate, setRate] = useState(String(controls.taxPct));
  const chooseTax = (tax: TaxSystem, pctText = rate) => {
    const taxPct = Number(pctText);
    const err = setControls({ ...controls, tax, taxPct: tax === 'flat' && taxPct >= 0 && taxPct <= 60 ? taxPct : controls.taxPct });
    if (err) useStore.getState().toast('bad', err);
  };
  const tone = (n: number) => (n > 0.005 ? 'up' : n < -0.005 ? 'down' : '');
  const Row = ({ label, value, note, strong, cls }: { label: string; value: string; note?: string; strong?: boolean; cls?: string }) => (
    <div className="ledger-row" data-strong={strong}>
      <span>
        {label}
        {note && <small>{note}</small>}
      </span>
      <span className={`num ${cls ?? ''}`}>{value}</span>
    </div>
  );
  return (
    <section className="panel profile-card" aria-labelledby="h-money">
      <div className="card-head">
        <h2 id="h-money">Your money</h2>
        <span className="mode-pill" data-mode={tradingMode}>
          {MODE_LABEL[tradingMode]}
        </span>
      </div>
      <div className="ledger" aria-label="From the starting amount to what you keep">
        <Row label="Started with" value={money(start)} note={test ? dateTime(test.startedAt) : 'Not started yet'} />
        <Row label="Profit before fees" value={signedMoney(l.gross)} note={`${trades.length} finished trade${trades.length === 1 ? '' : 's'}, ${trades.filter((t) => t.pnl > 0).length} won`} cls={tone(l.gross)} />
        <Row label="Fees" value={l.fees ? `−${money(l.fees)}` : money(0)} note="0.1% of each buy and sell. Prices above already include about 0.02% slippage." cls={l.fees ? 'down' : ''} />
        <Row label="Profit after fees" value={signedMoney(l.net)} cls={tone(l.net)} strong />
        <Row label={`Tax (${TAX_LABEL[controls.tax]})`} value={l.tax ? `−${money(l.tax)}` : money(0)} note={l.explain} cls={l.tax ? 'down' : ''} />
        {position && <Row label="Open trade" value={signedMoney(open)} note="Not finished: counted at today's price, before tax" cls={tone(open)} />}
        <Row label="What you keep" value={money(keep)} note={`${pct(start ? ((keep - start) / start) * 100 : 0)} on what you started with`} strong cls={tone(keep - start)} />
      </div>
      {controls.tax === 'india' && l.tds > 0 && (
        <p className="hint" style={{ margin: 0 }}>
          {INDIA_TDS * 100}% TDS withheld on sales: {money(l.tds)}. It is part of the tax above, not extra; whatever is more than the tax comes back when you file.
        </p>
      )}
      <div className="choice">
        <span className="field-label" id="tax-label">
          Tax system
        </span>
        <div className="choice-row">
          <div className="segmented" role="radiogroup" aria-labelledby="tax-label">
            {(['none', 'india', 'flat'] as TaxSystem[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={controls.tax === t} aria-pressed={controls.tax === t} onClick={() => chooseTax(t)}>
                {TAX_LABEL[t]}
              </button>
            ))}
          </div>
          {controls.tax === 'flat' && (
            <div className="input-wrap choice-input">
              <input aria-label="Tax rate" type="number" inputMode="decimal" min="0" max="60" step="any" value={rate} onChange={(e) => setRate(e.target.value)} onBlur={() => chooseTax('flat')} />
              <span className="affix">% of profit</span>
            </div>
          )}
        </div>
        <span className="hint">An estimate to show what is left at the end, not tax advice.</span>
      </div>
      <div className="session-grid">
        <div>
          <span className="stat-label">Balance now</span>
          <span className="stat-value num">{money(eq)}</span>
        </div>
        <div>
          <span className="stat-label">Cash</span>
          <span className="stat-value num">{money(cash)}</span>
        </div>
      </div>
      {tradingMode !== 'paper' && (
        <div className="binance-balances">
          <span className="stat-label">On Binance {tradingMode === 'testnet' ? 'Testnet' : ''}</span>
          {real.balances ? (
            <span>
              {real.balances.USDT.free.toFixed(2)} USDT free{real.balances.USDT.locked ? `, ${real.balances.USDT.locked.toFixed(2)} in orders` : ''} ·{' '}
              {(real.balances.BTC.free + real.balances.BTC.locked).toFixed(6)} BTC
            </span>
          ) : (
            <span className="hint">Connect Binance below to see your balances.</span>
          )}
          <button className="btn btn-sm" onClick={() => void syncRealCash()}>
            Refresh
          </button>
          <p className="hint" style={{ margin: 0, gridColumn: '1 / -1' }}>
            The bot spends only the USDT, one trade at a time. BTC you already had on Binance is never sold by the bot.
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ bot settings */

interface Form {
  timeframe: Timeframe;
  brain: boolean;
  risk: string;
  spendOn: boolean;
  spend: string;
  minOn: boolean;
  min: string;
  dailyOn: boolean;
  daily: string;
  hoursOn: boolean;
  from: string;
  to: string;
  closeAfterHours: boolean;
  limitOn: boolean;
  limit: string;
  allowShort: boolean;
  learnSkip: boolean;
}

const toForm = (c: Controls): Form => ({
  timeframe: c.timeframe,
  brain: c.brain,
  risk: String(c.riskPct),
  spendOn: c.maxSpend !== null,
  spend: c.maxSpend?.toString() ?? '',
  minOn: c.minSpend !== null,
  min: c.minSpend?.toString() ?? '',
  dailyOn: c.dailyTrades !== null,
  daily: String(c.dailyTrades ?? 15),
  hoursOn: c.hours !== null,
  from: String(c.hours?.from ?? 3),
  to: String(c.hours?.to ?? 5),
  closeAfterHours: c.closeAfterHours,
  limitOn: c.lossLimit !== null,
  limit: c.lossLimit?.toString() ?? '',
  allowShort: c.allowShort,
  learnSkip: c.learnSkip,
});
const num = (on: boolean, v: string) => (on ? (v.trim() === '' ? NaN : Number(v)) : null);
const toControls = (f: Form, base: Controls): Controls => ({
  ...base,
  timeframe: f.timeframe,
  brain: f.brain,
  riskPct: f.risk.trim() === '' ? NaN : Number(f.risk),
  maxSpend: num(f.spendOn, f.spend),
  minSpend: num(f.minOn, f.min),
  dailyTrades: num(f.dailyOn, f.daily),
  hours: f.hoursOn ? { from: Number(f.from), to: Number(f.to) } : null,
  closeAfterHours: f.closeAfterHours,
  lossLimit: num(f.limitOn, f.limit),
  allowShort: f.allowShort,
  learnSkip: f.learnSkip,
});
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

function BotSettings() {
  const controls = useStore((s) => s.controls);
  const tradingMode = useStore((s) => s.tradingMode);
  const currency = useStore((s) => s.account.currency);
  const setControls = useStore((s) => s.setControls);
  useStore((s) => s.cash);
  useStore((s) => s.positions);
  const px = useQuotes()[SYMBOL]?.last;
  const [form, setForm] = useState(() => toForm(controls));
  const [saved, setSaved] = useState('');
  useEffect(() => setForm(toForm(controls)), [controls]);
  const cur = currency === 'INR' ? '₹' : '$';
  const real = tradingMode !== 'paper';
  const next = toControls(form, controls);
  const problem = checkControls(next, tradingMode);
  const changed = JSON.stringify(next) !== JSON.stringify(controls);
  const up = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved('');
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const err = setControls(next);
    setSaved(err ?? 'Saved. They apply from the next trade.');
  };
  const eq = accountValue(px);
  const riskAmount = Number.isFinite(next.riskPct) ? (eq * next.riskPct) / 100 : 0;
  return (
    <form className="panel profile-card" aria-labelledby="h-settings" onSubmit={save}>
      <div className="card-head">
        <h2 id="h-settings">Bot settings</h2>
      </div>
      {tradingMode === 'paper' && <PaperMoney />}
      <div className="choice">
        <span className="field-label" id="tf-label">
          How often the bot decides
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="tf-label">
          {(['1m', '15m', '1h', '4h'] as Timeframe[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={form.timeframe === t} aria-pressed={form.timeframe === t} onClick={() => up({ timeframe: t })}>
              {TIMEFRAMES[t].short}
            </button>
          ))}
        </div>
        <span className="hint">
          {TIMEFRAMES[form.timeframe].label}, as each {TIMEFRAMES[form.timeframe].candle} candle closes, it checks whether to buy or sell short. {TIMEFRAMES[form.timeframe].results}
          {form.timeframe !== '4h' ? ' Deciding more often did not make more money in testing; 4 hours did best.' : ''}
        </span>
      </div>
      <div className="choice">
        <label className="field-label" htmlFor="risk">
          Most a trade can lose
        </label>
        <div className="choice-row">
          <div className="input-wrap choice-input">
            <input id="risk" type="number" inputMode="decimal" min="0.1" max="10" step="0.1" value={form.risk} onChange={(e) => up({ risk: e.target.value })} />
            <span className="affix">% of the balance</span>
          </div>
          <span className="num risk-amount">= {money(riskAmount)} now</span>
        </div>
        <span className="hint">
          Every trade is sized so that if its stop loss is hit, it loses no more than this, fees included. A small balance makes small trades. Prices can jump past a stop
          now and then, so a loss can be a little larger.
        </span>
      </div>
      <Choice
        label="Most to spend on one trade"
        offLabel={real ? 'Not set' : 'No cap'}
        onLabel="Up to"
        on={form.spendOn}
        onToggle={(spendOn) => up({ spendOn })}
        value={form.spend}
        onValue={(spend) => up({ spend })}
        prefix={cur}
        placeholder={real ? '50' : '2000'}
        hint={real ? 'Required for real trading: no buy spends more USDT than this. Start small.' : 'Optional. Trades are normally sized by the loss limit above.'}
      />
      <Choice
        label="Least to spend on one trade"
        offLabel="No minimum"
        onLabel="At least"
        on={form.minOn}
        onToggle={(minOn) => up({ minOn })}
        value={form.min}
        onValue={(min) => up({ min })}
        prefix={cur}
        placeholder="5"
        hint="Optional. A trade the loss limit would make smaller is raised to this, so its loss at the stop can then be a little more."
      />
      <Choice
        label="Trades a day"
        offLabel="No limit"
        onLabel="At most"
        on={form.dailyOn}
        onToggle={(dailyOn) => up({ dailyOn })}
        value={form.daily}
        onValue={(daily) => up({ daily })}
        suffix="trades"
        placeholder="15"
        hint="New trades counted from midnight. In testing the bot traded 3–7 times a month on any timeframe, so a limit rarely bites."
      />
      <div className="choice">
        <span className="field-label" id="hours-label">
          Trading hours
        </span>
        <div className="choice-row">
          <div className="segmented" role="radiogroup" aria-labelledby="hours-label">
            <button type="button" role="radio" aria-checked={!form.hoursOn} aria-pressed={!form.hoursOn} onClick={() => up({ hoursOn: false })}>
              Any time
            </button>
            <button type="button" role="radio" aria-checked={form.hoursOn} aria-pressed={form.hoursOn} onClick={() => up({ hoursOn: true })}>
              Only
            </button>
          </div>
          {form.hoursOn && (
            <div className="hours-pick">
              <select aria-label="From" value={form.from} onChange={(e) => up({ from: e.target.value })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hh(h)}
                  </option>
                ))}
              </select>
              <span className="muted">to</span>
              <select aria-label="To" value={form.to} onChange={(e) => up({ to: e.target.value })}>
                {HOURS.map((h) => (
                  <option key={h + 1} value={h + 1}>
                    {hh(h + 1)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {form.hoursOn && (
          <label className="check-line">
            <input type="checkbox" checked={form.closeAfterHours} onChange={(e) => up({ closeAfterHours: e.target.checked })} /> Close the open trade when the hours end
          </label>
        )}
        <span className="hint">
          {form.hoursOn
            ? `Your computer's time. New trades only between ${describeHours(next.hours)}. A signal that comes earlier waits for your hours while it is still current. ${form.closeAfterHours ? 'An open trade is closed when the hours end.' : 'An open trade keeps its stop and target outside your hours.'}`
            : 'The bot may open a trade at any hour.'}
        </span>
      </div>
      <div className="choice">
        <span className="field-label" id="short-label">
          When BTC falls
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="short-label">
          <button type="button" role="radio" aria-checked={form.allowShort && !real} aria-pressed={form.allowShort && !real} disabled={real} onClick={() => up({ allowShort: true })}>
            Sell short
          </button>
          <button type="button" role="radio" aria-checked={!form.allowShort || real} aria-pressed={!form.allowShort || real} onClick={() => up({ allowShort: false })}>
            Stay out
          </button>
        </div>
        <span className="hint">
          {real
            ? 'Binance spot can only sell BTC it holds, so real trading only buys.'
            : 'Selling short lets the bot profit in a downtrend: it sells first and buys back lower. In testing, buys and shorts together did better than buys alone.'}
        </span>
      </div>
      <Choice
        label="Loss limit"
        offLabel="Off"
        onLabel="Stop after losing"
        on={form.limitOn}
        onToggle={(limitOn) => up({ limitOn })}
        value={form.limit}
        onValue={(limit) => up({ limit })}
        prefix={cur}
        placeholder="200"
        hint="Once the test has lost this much, the bot closes its trade and stops."
      />
      <div className="choice">
        <span className="field-label" id="learn-label">
          Learning from mistakes
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="learn-label">
          <button type="button" role="radio" aria-checked={!form.learnSkip} aria-pressed={!form.learnSkip} onClick={() => up({ learnSkip: false })}>
            Record lessons
          </button>
          <button type="button" role="radio" aria-checked={form.learnSkip} aria-pressed={form.learnSkip} onClick={() => up({ learnSkip: true })}>
            Also skip losing situations
          </button>
        </div>
        <span className="hint">
          The bot always records why trades won or lost (below). Skipping situations that kept losing sounds smart but did not help in testing: it lost more than taking
          every signal, and no better than skipping at random. Try it if you like; you can compare in the test record.
        </span>
      </div>
      <div className="choice">
        <span className="field-label" id="brain-label">
          Neural network
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="brain-label">
          <button type="button" role="radio" aria-checked={!form.brain} aria-pressed={!form.brain} onClick={() => up({ brain: false })}>
            Only watch and learn
          </button>
          <button type="button" role="radio" aria-checked={form.brain} aria-pressed={form.brain} onClick={() => up({ brain: true })}>
            Skip trades once trusted
          </button>
        </div>
        <span className="hint">
          The network learns from every signal's result either way. With the second choice it may also skip a trade it expects to lose, but only after the signals it
          would have skipped have clearly lost money. See its record below.
        </span>
      </div>
      <div className="form-foot">
        <button className="btn btn-buy" type="submit" disabled={!changed || !!problem}>
          Save settings
        </button>
        <span className={problem && changed ? 'error-text' : 'hint'} role="status">
          {problem && changed ? problem : saved}
        </span>
      </div>
    </form>
  );
}

/** Rupees per US dollar from a free public rate service; USDT tracks the dollar closely. */
async function fetchInrRate(): Promise<number | null> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
    const rate = Number((await r.json())?.rates?.INR);
    return rate > 50 && rate < 200 ? rate : null;
  } catch {
    return null;
  }
}

function PaperMoney() {
  const account = useStore((s) => s.account);
  const locked = useStore((s) => !!s.test || s.positions.length > 0 || s.trades.length > 0);
  const setAccount = useStore((s) => s.setAccount);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [other, setOther] = useState(account.amount ? String(account.amount) : '');
  const custom = !!account.amount;
  const choose = async (currency: 'USD' | 'INR', amount?: number) => {
    if (currency === account.currency && amount === account.amount) return;
    if (locked) return toast('info', 'To change the paper money, start over first (the ↻ button at the top right).');
    if (currency === account.currency && account.currency === 'USD') {
      const err = setAccount({ ...account, amount });
      if (err) toast('info', err);
      return;
    }
    let rate = 1;
    if (currency === 'INR') {
      setBusy(true);
      const live = await fetchInrRate();
      setBusy(false);
      rate = live ?? FALLBACK_INR_RATE;
      if (!live) toast('info', `Couldn't fetch today's rupee rate, so ₹${FALLBACK_INR_RATE} per dollar is used.`);
    }
    const err = setAccount({ currency, rate, amount });
    if (err) toast('info', err);
  };
  const setOtherAmount = () => {
    const n = Number(other);
    if (!(n >= 10 && n <= 100_000_000)) return toast('info', 'Choose an amount of at least $10.');
    void choose('USD', n);
  };
  return (
    <div className="choice">
      <span className="field-label" id="paper-label">
        Paper money
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby="paper-label">
        {(['USD', 'INR'] as const).map((c) => {
          const on = account.currency === c && !custom;
          return (
            <button key={c} type="button" role="radio" aria-checked={on} aria-pressed={on} disabled={busy || (locked && !on)} onClick={() => void choose(c)}>
              {c === 'USD' ? '$10,000' : '₹1,00,000'}
            </button>
          );
        })}
      </div>
      <div className="choice-row">
        <div className="input-wrap choice-input">
          <span className="affix">$</span>
          <input id="paper-amount" aria-label="Other amount in dollars" type="number" inputMode="decimal" min="10" step="any" placeholder="150" value={other} disabled={locked} onChange={(e) => setOther(e.target.value)} />
        </div>
        <button type="button" className="btn btn-sm" disabled={locked || !other || Number(other) === account.amount} onClick={setOtherAmount}>
          Use this amount
        </button>
      </div>
      <span className="hint">
        Starts with {startLabel(account)}.{' '}
        {account.currency === 'INR' ? `Held as ${startCash(account).toFixed(2)} USDT at ₹${account.rate.toFixed(2)} per USDT, fixed for this test.` : 'Amounts are in US dollars (USDT).'}
        {locked ? ' To change it, start over with the ↻ button at the top right.' : ''}
      </span>
    </div>
  );
}

function Choice(props: {
  label: string;
  offLabel: string;
  onLabel: string;
  on: boolean;
  onToggle(on: boolean): void;
  value: string;
  onValue(v: string): void;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  hint: string;
}) {
  const id = useId();
  return (
    <div className="choice">
      <span className="field-label" id={`${id}-label`}>
        {props.label}
      </span>
      <div className="choice-row">
        <div className="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
          <button type="button" role="radio" aria-checked={!props.on} aria-pressed={!props.on} onClick={() => props.onToggle(false)}>
            {props.offLabel}
          </button>
          <button type="button" role="radio" aria-checked={props.on} aria-pressed={props.on} onClick={() => props.onToggle(true)}>
            {props.onLabel}
          </button>
        </div>
        {props.on && (
          <div className="input-wrap choice-input">
            {props.prefix && <span className="affix">{props.prefix}</span>}
            <input
              id={`${id}-value`}
              aria-labelledby={`${id}-label`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={props.value}
              placeholder={props.placeholder}
              onChange={(e) => props.onValue(e.target.value)}
            />
            {props.suffix && <span className="affix">{props.suffix}</span>}
          </div>
        )}
      </div>
      <span className="hint">{props.hint}</span>
    </div>
  );
}

/* ------------------------------------------------------------ lessons */

const SITUATIONS: Situation[] = ['long|with|calm', 'long|with|wild', 'long|against|calm', 'long|against|wild', 'short|with|calm', 'short|with|wild', 'short|against|calm', 'short|against|wild'];

function Lessons() {
  const { lessons, outcomes, from, to, timeframe } = useLessons();
  const candle = TIMEFRAMES[timeframe ?? '4h'].candle;
  const trades = useStore((s) => s.trades);
  const learnSkip = useStore((s) => s.controls.learnSkip);
  const losses = useMemo(() => trades.filter((t) => t.pnl < 0 && t.openedBy === 'bot').slice(-5).reverse(), [trades]);
  const fmtDay = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <section className="panel profile-card wide" aria-labelledby="h-lessons">
      <div className="card-head">
        <h2 id="h-lessons">What the bot has learned</h2>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {outcomes.length
          ? `Every momentum signal on the ${candle} chart from ${fmtDay(from)} to ${fmtDay(to)}, taken or not, followed to its stop or target: ${outcomes.length} results, sorted by the situation they came in. Relearned as new candles close. The result is in units of the money at risk: −1 is a full stop loss, +2.3 a full target.`
          : `Loading the ${TIMEFRAMES[useStore.getState().controls.timeframe].candle} chart…`}
      </p>
      {outcomes.length > 0 && (
        <table className="table lessons">
          <thead>
            <tr>
              <th>Situation</th>
              <th className="r">Signals</th>
              <th className="r">Won</th>
              <th className="r">Average result</th>
              <th>{learnSkip ? 'The bot' : 'Lesson'}</th>
            </tr>
          </thead>
          <tbody>
            {SITUATIONS.map((s) => {
              const rec = lessons[s];
              const v = lessonVerdict(lessons, s);
              const avg = rec?.n ? rec.sumR / rec.n : 0;
              return (
                <tr key={s}>
                  <td>{describeSituation(s)}</td>
                  <td className="r num">{rec?.n ?? 0}</td>
                  <td className="r num">{rec?.n ? `${Math.round((100 * rec.wins) / rec.n)}%` : '—'}</td>
                  <td className={`r num ${avg > 0 ? 'up' : avg < 0 ? 'down' : ''}`}>{rec?.n ? `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}× risk` : '—'}</td>
                  <td>
                    {!rec || rec.n < LESSON_MIN
                      ? 'Too few to judge'
                      : v.skip
                        ? learnSkip
                          ? 'Skips it'
                          : 'Keeps losing'
                        : shrunkAverage(rec) > 0.15
                          ? 'Works'
                          : 'Mixed'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div>
        <span className="stat-label">Why the bot's last losing trades lost</span>
        {losses.length ? (
          <ul className="loss-list">
            {losses.map((t) => (
              <li key={t.id}>
                <span className={`num down`}>{signedMoney(t.pnl)}</span> <span className="muted">{dateTime(t.exitTime)}</span> — {lossCause(t, lessons)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint" style={{ margin: '4px 0 0' }}>
            No losing trades yet.
          </p>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ neural network */

function NeuralNetwork() {
  const { brain, outcomes, timeframe, status } = useLessons();
  const on = useStore((s) => s.controls.brain);
  const chosen = useStore((s) => s.controls.timeframe);
  const candle = TIMEFRAMES[timeframe ?? chosen].candle;
  const ok = brain && brain.learned >= BRAIN_WARMUP;
  const isTrusted = brain ? trusted(brain) : false;
  const avg = brain && brain.skippedN ? brain.skippedR / brain.skippedN : null;
  const state = !brain
    ? status === 'offline'
      ? { text: "Can't load the price history", tone: 'down' }
      : { text: 'Learning from history…', tone: '' }
    : !ok
      ? { text: 'Still learning', tone: '' }
      : isTrusted
        ? { text: on ? 'Trusted: it may skip trades' : 'Trusted, but only watching (your choice)', tone: 'up' }
        : { text: 'Not trusted yet: it only watches', tone: '' };
  return (
    <section className="panel profile-card wide" aria-labelledby="h-net">
      <div className="card-head">
        <h2 id="h-net">Neural network</h2>
        <span className={`mode-pill ${state.tone}`}>{state.text}</span>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        A small neural network (14 inputs, 12 hidden units) that learns, from every {candle} momentum signal and how it ended, to estimate a new signal's chance of
        reaching its target. It learns in time order, judging each signal with only the results finished before it, the same way it works live.
      </p>
      {brain && (
        <div className="session-grid three">
          <div>
            <span className="stat-label">Learned from</span>
            <span className="stat-value num">{brain.learned.toLocaleString()} results</span>
            <span className="hint">{Math.round((100 * brain.wins) / Math.max(1, brain.learned))}% reached the target</span>
          </div>
          <div>
            <span className="stat-label">Its skips so far</span>
            <span className="stat-value num">{brain.skippedN.toLocaleString()} signals</span>
            <span className="hint">{avg === null ? 'none yet' : `averaged ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}× the risk`}</span>
          </div>
          <div>
            <span className="stat-label">Trusted when</span>
            <span className="stat-value num">≥ {TRUST_MIN} skips, ≤ {TRUST_AVG}×</span>
            <span className="hint">skipped signals must have clearly lost</span>
          </div>
        </div>
      )}
      <p className="hint" style={{ margin: 0 }}>
        {avg === null || !brain
          ? `It needs ${BRAIN_WARMUP} results before its opinion counts.`
          : avg <= TRUST_AVG
            ? 'The signals it would have skipped did lose money, so its judgement has been useful.'
            : `The signals it would have skipped ${avg > 0 ? 'made money on average, so skipping them would have cost you' : 'were about break-even, so skipping them would not have helped'}. Until that changes it only watches.`}{' '}
        In testing on 20 months of prices it never earned trust on 4-hour or 1-hour candles, and when it briefly did on 15-minute and 1-minute candles it cost 2–3%.
        A placebo trained on shuffled results did about as well, so treat its view as an experiment, not an edge.
      </p>
      <details className="help">
        <summary>What it looks at</summary>
        <p className="hint" style={{ margin: '6px 0 0' }}>
          {BRAIN_INPUTS.join(' · ')}. {outcomes.length.toLocaleString()} signals in the history it learned from.
        </p>
      </details>
    </section>
  );
}

/* ------------------------------------------------------------ how it trades */

function HowItTrades() {
  const tradingMode = useStore((s) => s.tradingMode);
  const spec = botSpec(useStore((s) => s.controls));
  return (
    <section className="panel profile-card wide" aria-labelledby="h-how">
      <div className="card-head">
        <h2 id="h-how">How the bot trades</h2>
      </div>
      <dl className="spec">
        <dt>Market</dt>
        <dd>BTC/USDT on Binance</dd>
        {spec.spec.map(([k, v]) => [
          <dt key={`${k}-t`}>{k}</dt>,
          <dd key={`${k}-d`}>{k === 'Sells short when' && tradingMode !== 'paper' ? 'Never with real money: Binance spot can only sell BTC it holds' : v}</dd>,
        ])}
        <dt>Costs</dt>
        <dd>0.1% fee and 0.02% slippage on every order</dd>
      </dl>
      <p className="hint" style={{ margin: 0 }}>
        {spec.results}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------ real trading */

function RealTrading() {
  const tradingMode = useStore((s) => s.tradingMode);
  const locked = useStore((s) => !!s.test || s.positions.length > 0 || s.trades.length > 0);
  const amountSet = useStore((s) => !!s.controls.maxSpend);
  const setTradingMode = useStore((s) => s.setTradingMode);
  const real = useReal();
  const [env, setEnv] = useState<'testnet' | 'live'>(tradingMode === 'live' ? 'live' : 'testnet');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [wantReal, setWantReal] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const keyId = useId();

  const choose = (m: TradingMode) => {
    setMessage(null);
    if (m === 'live' && tradingMode !== 'live') {
      setWantReal(true);
      setEnv('live');
      return;
    }
    setWantReal(false);
    const err = setTradingMode(m);
    if (err) setMessage({ text: err, ok: false });
    else if (m !== 'paper') void syncRealCash();
  };
  const confirmReal = () => {
    const err = setTradingMode('live');
    if (err) return setMessage({ text: err, ok: false });
    setWantReal(false);
    void syncRealCash();
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const note = await connectReal(env, apiKey, apiSecret);
    setBusy(false);
    const ok = useReal.getState().state === 'connected';
    setMessage(note ? { text: note, ok } : null);
    if (ok) {
      setApiKey('');
      setApiSecret('');
      void syncRealCash();
    }
  };
  const liveReady = real.state === 'connected' && real.environment === 'live';

  return (
    <section className="panel profile-card wide" aria-labelledby="h-real">
      <div className="card-head">
        <h2 id="h-real">Trade with Binance</h2>
      </div>

      <div className="choice">
        <span className="field-label">Where the bot trades</span>
        <div className="segmented" role="radiogroup" aria-label="Where the bot trades">
          {(['paper', 'testnet', 'live'] as TradingMode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={tradingMode === m} aria-pressed={tradingMode === m} disabled={locked && tradingMode !== m} onClick={() => choose(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span className="hint">
          {tradingMode === 'paper'
            ? 'Practice money inside the app. Nothing is sent to Binance.'
            : tradingMode === 'testnet'
              ? "Binance's test exchange, with free test money. Real orders, no real money. Its prices can differ from the real market."
              : 'Your real Binance account. Every buy and sell uses your money.'}
          {locked ? ' To switch, start over first (the ↻ button at the top right).' : ''}
        </span>
      </div>

      {wantReal && (
        <div className="real-confirm" role="alert">
          <strong>Trade with real money?</strong>
          <p>
            The bot will buy and sell BTC with the USDT in your Binance account, never more than your most-to-spend per trade, with a stop loss on every trade. In testing
            on past prices this bot made small gains in some periods and small losses in others; it is not a sure thing. Only use money you can afford to lose. In India, profits are taxed at 30% plus cess, and losses can't
            reduce that tax.
          </p>
          {!liveReady && <p className="error-text">First connect a real-money API key below.</p>}
          {!amountSet && <p className="error-text">First set a most-to-spend amount in Bot settings.</p>}
          <label className="check-line">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand the bot trades my real money and can lose it.
          </label>
          <div className="form-foot">
            <button className="btn btn-danger-solid" type="button" disabled={!understood || !liveReady || !amountSet} onClick={confirmReal}>
              Use real money
            </button>
            <button className="btn" type="button" onClick={() => setWantReal(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="choice">
        <span className="field-label">Binance connection</span>
        {real.state === 'unavailable' ? (
          <p className="error-text" style={{ margin: 0 }}>
            {real.message}
          </p>
        ) : real.state === 'connected' ? (
          <div className="connected">
            <span>
              <span className="feed-dot" data-status="live" /> Connected: {real.environment === 'live' ? 'real-money' : 'Testnet'} key {real.keyHint}
            </span>
            <button className="btn btn-sm" type="button" disabled={locked && tradingMode !== 'paper'} onClick={() => void disconnectReal()} title={locked && tradingMode !== 'paper' ? 'Start over before removing the key the bot is trading with.' : undefined}>
              Remove key
            </button>
          </div>
        ) : (
          <form className="connect-form" onSubmit={connect}>
            <div className="segmented" role="radiogroup" aria-label="Which Binance">
              <button type="button" role="radio" aria-checked={env === 'testnet'} aria-pressed={env === 'testnet'} onClick={() => setEnv('testnet')}>
                Testnet key
              </button>
              <button type="button" role="radio" aria-checked={env === 'live'} aria-pressed={env === 'live'} onClick={() => setEnv('live')}>
                Real-money key
              </button>
            </div>
            <label className="field">
              <span className="field-label">API key</span>
              <span className="input-wrap">
                <input id={`${keyId}-key`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
              </span>
            </label>
            <label className="field">
              <span className="field-label">Secret key</span>
              <span className="input-wrap">
                <input id={`${keyId}-secret`} type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} autoComplete="off" />
              </span>
            </label>
            <div className="form-foot">
              <button className="btn btn-buy" type="submit" disabled={busy || apiKey.trim().length < 16 || apiSecret.trim().length < 16}>
                {busy ? 'Checking with Binance…' : 'Connect'}
              </button>
            </div>
          </form>
        )}
        {message && (
          <p className={message.ok ? 'hint' : 'error-text'} role="status" style={{ margin: 0 }}>
            {message.text}
          </p>
        )}
      </div>

      <details className="help">
        <summary>How to get an API key</summary>
        <div className="help-cols">
          <div>
            <strong>Testnet (free test money, try this first)</strong>
            <ol>
              <li>Open testnet.binance.vision and log in with GitHub.</li>
              <li>Click Generate HMAC_SHA256 Key, give it any name.</li>
              <li>Copy the API key and secret key into the form above, with Testnet key selected.</li>
            </ol>
          </div>
          <div>
            <strong>Real money</strong>
            <ol>
              <li>In Binance, go to Profile → API Management → Create API (system generated).</li>
              <li>Turn on Enable Spot &amp; Margin Trading. Leave Enable Withdrawals off: the app refuses keys that can withdraw.</li>
              <li>Restrict access to your computer's IP address if you can.</li>
              <li>Copy both keys into the form above, with Real-money key selected.</li>
            </ol>
          </div>
        </div>
        <p className="hint">
          Your keys are saved only on this computer, in the CRDTrade folder (.crdtrade/binance-keys.json). The browser never sees the secret key, and the app's local
          server only answers this app.
        </p>
      </details>
    </section>
  );
}
