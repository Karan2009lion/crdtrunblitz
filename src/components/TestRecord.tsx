import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useStore, botSpec, SYMBOL } from '../store/useStore';
import { readTokens, usePrices } from '../hooks/useMarket';
import { accountValue, livePrice } from '../engine/bot';
import { dateTime, displayRate, downloadText, duration, money, pct, signedMoney } from '../lib/format';
import { Icon } from './Icon';

/** The test record: how the account did hour by hour against holding BTC, and a downloadable report. */

export function TestRecord() {
  const test = useStore((s) => s.test);
  const trades = useStore((s) => s.trades);
  const snapshots = useStore((s) => s.snapshots);
  const offlineMs = useStore((s) => s.offlineMs);
  const theme = useStore((s) => s.theme);
  const prices = usePrices();
  const px = prices[SYMBOL];

  if (!test) {
    return (
      <div className="empty">
        <strong>No test yet</strong>
        <p>Press Start bot on the main screen. From then on the account is tracked hour by hour against simply holding BTC.</p>
      </div>
    );
  }

  const eq = accountValue(px);
  const holdEq = px ? (test.startEquity * px) / test.startPrice : test.startEquity;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  let peak = test.startEquity;
  let maxDd = 0;
  for (const sn of [...snapshots, { equity: eq }]) {
    peak = Math.max(peak, sn.equity);
    maxDd = Math.max(maxDd, ((peak - sn.equity) / peak) * 100);
  }
  const elapsed = Date.now() - test.startedAt;
  const Stat = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value num ${tone ?? ''}`}>{value}</span>
    </div>
  );
  const sign = (n: number) => (n > 0.005 ? 'up' : n < -0.005 ? 'down' : '');

  return (
    <div className="perf">
      <div className="perf-stats">
        <Stat label="Bot result" value={`${signedMoney(eq - test.startEquity)} (${pct(((eq - test.startEquity) / test.startEquity) * 100)})`} tone={sign(eq - test.startEquity)} />
        <Stat label="Holding BTC instead" value={`${signedMoney(holdEq - test.startEquity)} (${pct(((holdEq - test.startEquity) / test.startEquity) * 100)})`} tone={sign(holdEq - test.startEquity)} />
        <Stat label="Started" value={dateTime(test.startedAt)} />
        <Stat label="Running for" value={duration(elapsed)} />
        <Stat label="Trades" value={`${trades.length} · ${wins.length} won`} />
        <Stat label="Profit factor" value={grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : wins.length ? '∞' : '—'} />
        <Stat label="Biggest drop" value={`${maxDd.toFixed(2)}%`} />
        <Stat label="Fees paid" value={money(trades.reduce((s, t) => s + t.fees, 0))} />
        <Stat label="Time without prices" value={offlineMs ? `${duration(offlineMs)} (${((offlineMs / Math.max(1, elapsed)) * 100).toFixed(1)}%)` : 'None'} />
        <div className="stat">
          <span className="stat-label">Report</span>
          <button className="btn btn-sm" style={{ alignSelf: 'flex-start', marginTop: 2 }} onClick={() => exportReport()}>
            <Icon name="download" /> Download test report
          </button>
        </div>
      </div>
      <TestChart startPrice={test.startPrice} startEquity={test.startEquity} theme={theme} />
    </div>
  );
}

/** Everything about the test in one JSON file, for keeping or sharing. */
function exportReport() {
  const s = useStore.getState();
  if (!s.test) return;
  const px = livePrice();
  const eq = accountValue(px);
  const report = {
    app: 'CRDTrade BTC trader',
    exportedAt: new Date().toISOString(),
    strategy: {
      market: 'BTC/USDT (Binance)',
      mode: botSpec(s.controls).label,
      details: Object.fromEntries(botSpec(s.controls).spec),
      candles: botSpec(s.controls).interval,
      neuralNetworkMaySkip: s.controls.brain,
      shorting: s.settings.allowShort,
      mostLostPerTradePct: s.settings.riskPct,
      currency: s.account.currency === 'INR' ? 'INR (amounts below are in USDT; multiply by inrPerUsdt)' : 'USD',
      inrPerUsdt: s.account.currency === 'INR' ? s.account.rate : null,
      feePct: s.settings.feePct,
      slippagePct: s.settings.slippagePct,
    },
    summary: {
      startedAt: new Date(s.test.startedAt).toISOString(),
      startEquity: s.test.startEquity,
      startPrice: s.test.startPrice,
      endEquity: eq,
      endPrice: px,
      botReturnPct: ((eq - s.test.startEquity) / s.test.startEquity) * 100,
      holdReturnPct: px ? ((px - s.test.startPrice) / s.test.startPrice) * 100 : null,
      trades: s.trades.length,
      wins: s.trades.filter((t) => t.pnl > 0).length,
      fees: s.trades.reduce((a, t) => a + t.fees, 0),
      timeWithoutPricesMinutes: Math.round(s.offlineMs / 60_000),
      openPosition: s.positions[0] ?? null,
    },
    yourSettings: s.controls,
    hourly: s.snapshots.map((sn) => ({ time: new Date(sn.time).toISOString(), equity: +sn.equity.toFixed(2), btcPrice: sn.price })),
    trades: s.trades.map((t) => ({ ...t, entryTime: new Date(t.entryTime).toISOString(), exitTime: new Date(t.exitTime).toISOString() })),
    log: s.logs
      .slice()
      .reverse()
      .map((l) => ({ time: new Date(l.time).toISOString(), type: l.level, message: l.message })),
  };
  downloadText(`crdtrade-btc-test-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(report, null, 2), 'application/json');
}

/** The bot's account against holding BTC, hour by hour since the test started. */
function TestChart({ startPrice, startEquity, theme }: { startPrice: number; startEquity: number; theme: string }) {
  const snapshots = useStore((s) => s.snapshots);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const bot = useRef<ISeriesApi<'Line'> | null>(null);
  const hold = useRef<ISeriesApi<'Line'> | null>(null);
  const startLine = useRef<IPriceLine | null>(null);

  useEffect(() => {
    const c = createChart(el.current!, { autoSize: true, timeScale: { timeVisible: true } });
    hold.current = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: 'Holding BTC' });
    bot.current = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: 'Bot' });
    chart.current = c;
    return () => {
      c.remove();
      startLine.current = null;
    };
  }, []);

  useEffect(() => {
    const t = readTokens();
    chart.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: t.line } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    bot.current?.applyOptions({ color: t.accent });
    hold.current?.applyOptions({ color: t.focus, lineStyle: LineStyle.Dotted });
    const pts = snapshots.filter((sn, i) => i === 0 || Math.floor(sn.time / 1000) > Math.floor(snapshots[i - 1].time / 1000));
    const k = displayRate();
    bot.current?.setData(pts.map((sn) => ({ time: Math.floor(sn.time / 1000) as UTCTimestamp, value: sn.equity * k })));
    hold.current?.setData(pts.map((sn) => ({ time: Math.floor(sn.time / 1000) as UTCTimestamp, value: ((startEquity * sn.price) / startPrice) * k })));
    if (startLine.current) bot.current?.removePriceLine(startLine.current);
    startLine.current =
      bot.current?.createPriceLine({ price: startEquity * k, color: t.lineStrong, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: 'Start' }) ?? null;
    chart.current?.timeScale().fitContent();
  }, [snapshots, theme, startEquity, startPrice]);

  return <div className="perf-chart" ref={el} aria-label="Bot account value against holding BTC, every hour since the test started" />;
}
