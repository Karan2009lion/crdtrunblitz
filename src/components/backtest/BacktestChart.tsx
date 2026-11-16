import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { ema } from '../../lib/indicators';
import { priceDecimals } from '../../lib/format';
import { readTokens } from '../../hooks/useMarket';
import { useStore } from '../../store/useStore';
import { displayRate } from '../../lib/format';
import { tfSeconds, type BacktestResult, type BacktestTimeframe } from '../../engine/backtest';

const ts = (t: number) => t as UTCTimestamp;

interface Series {
  candles: ISeriesApi<'Candlestick'>;
  fast: ISeriesApi<'Line'>;
  slow: ISeriesApi<'Line'>;
  equity: ISeriesApi<'Line'>;
  markers: ISeriesMarkersPluginApi<Time>;
}

/** Price with the bot's buys and sells, plus the account value in a lower pane, revealed as the replay advances. */
export function BacktestChart({ result, cursor, timeframe }: { result: BacktestResult; cursor: number; timeframe: BacktestTimeframe }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<Series | null>(null);
  const shown = useRef({ bars: 0, equity: 0, fills: -1 });
  const lines = useRef<{ fast: number[]; slow: number[] }>({ fast: [], slow: [] });
  const startLine = useRef<IPriceLine | null>(null);
  const theme = useStore((s) => s.theme);
  const sec = tfSeconds(timeframe);

  useEffect(() => {
    const c = createChart(el.current!, {
      autoSize: true,
      timeScale: { timeVisible: true, rightOffset: 4 },
      localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
    });
    const line = { lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const candles = c.addSeries(CandlestickSeries, { borderVisible: false });
    const fast = c.addSeries(LineSeries, line);
    const slow = c.addSeries(LineSeries, line);
    const equity = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: 'Account' }, 1);
    c.panes()[1]?.setStretchFactor(0.35);
    chart.current = c;
    series.current = { candles, fast, slow, equity, markers: createSeriesMarkers(candles, []) };
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    const t = readTokens();
    chart.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font, attributionLogo: true, panes: { separatorColor: t.line } },
      grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
      rightPriceScale: { borderColor: t.line },
      timeScale: { borderColor: t.line },
    });
    const s = series.current;
    if (!s) return;
    s.candles.applyOptions({ upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down });
    s.fast.applyOptions({ color: t.accent });
    s.slow.applyOptions({ color: t.focus });
    s.equity.applyOptions({ color: t.focus });
    shown.current.fills = -1; // recolour markers
  }, [theme]);

  // New result: reset everything.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const closes = result.bars.map((b) => b.close);
    lines.current = { fast: ema(closes, 9), slow: ema(closes, 21) };
    const p = priceDecimals(result.bars[result.bars.length - 1]?.close ?? 1);
    s.candles.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: 1 / 10 ** p } });
    for (const x of [s.candles, s.fast, s.slow, s.equity]) x.setData([]);
    s.markers.setMarkers([]);
    if (startLine.current) s.equity.removePriceLine(startLine.current);
    startLine.current = s.equity.createPriceLine({ price: result.stats.startCash * displayRate(), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: 'Start', color: '#8c97b2' });
    shown.current = { bars: 0, equity: 0, fills: -1 };
  }, [result]);

  // Reveal up to the cursor.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const { bars, equity, fills } = result;
    const st = shown.current;
    const target = upperBound(bars, (b) => b.time + sec <= cursor);
    const big = target - st.bars > 400;
    const slice = bars.slice(st.bars, target);
    const lineAt = (arr: number[], i: number) => (Number.isFinite(arr[i]) ? { time: ts(bars[i].time), value: arr[i] } : null);
    if (big) {
      s.candles.setData(bars.slice(0, target).map((b) => ({ time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
      s.fast.setData(bars.slice(0, target).flatMap((_, i) => lineAt(lines.current.fast, i) ?? []));
      s.slow.setData(bars.slice(0, target).flatMap((_, i) => lineAt(lines.current.slow, i) ?? []));
    } else {
      slice.forEach((b, k) => {
        const i = st.bars + k;
        s.candles.update({ time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
        const f = lineAt(lines.current.fast, i);
        const sl = lineAt(lines.current.slow, i);
        if (f) s.fast.update(f);
        if (sl) s.slow.update(sl);
      });
    }
    st.bars = target;

    const eqTarget = upperBound(equity, (p) => p.time <= cursor);
    if (eqTarget > st.equity) {
      const pts = equity.slice(0, eqTarget).map((p) => ({ time: ts(p.time), value: p.value * displayRate() }));
      s.equity.setData(dedupe(pts));
      st.equity = eqTarget;
    }

    const fillTarget = upperBound(fills, (f) => f.time <= cursor * 1000);
    if (fillTarget !== st.fills) {
      const t = readTokens();
      const first = bars[0]?.time ?? 0;
      const lastShown = target ? bars[target - 1].time : -1;
      const marks: SeriesMarker<Time>[] = fills.slice(0, fillTarget).flatMap((f) => {
        const time = Math.max(first, Math.floor((f.time / 1000 - 1) / sec) * sec);
        return time > lastShown ? [] : [{ ...f, time }];
      }).map((f) => ({
        time: ts(f.time),
        position: f.action === 'buy' ? 'belowBar' : 'aboveBar',
        shape: f.action === 'buy' ? 'arrowUp' : 'arrowDown',
        color: f.action === 'buy' ? t.up : t.down,
        text: f.kind === 'open' ? (f.action === 'buy' ? 'Buy' : 'Short') : f.action === 'buy' ? 'Cover' : 'Sell',
      }) as SeriesMarker<Time>);
      s.markers.setMarkers(marks);
      st.fills = fillTarget;
    }
  }, [result, cursor, sec, theme]);

  return <div className="chart-canvas" ref={el} />;
}

/** Number of leading items that satisfy `ok` (items are sorted so `ok` flips once). */
function upperBound<T>(arr: T[], ok: (x: T) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(arr[mid])) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function dedupe(pts: { time: UTCTimestamp; value: number }[]) {
  const out: typeof pts = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].time >= p.time) out[out.length - 1] = { ...p, time: out[out.length - 1].time };
    else out.push(p);
  }
  return out;
}
