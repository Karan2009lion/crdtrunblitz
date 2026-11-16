import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
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
import { hub } from '../market/hub';
import { useStore } from '../store/useStore';
import { bollinger, ema } from '../lib/indicators';
import { intervalSeconds } from '../lib/markets';
import { priceDecimals, price as fmtPrice } from '../lib/format';
import { readTokens } from '../hooks/useMarket';
import type { Candle } from '../types';

interface Series {
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  fast: ISeriesApi<'Line'>;
  slow: ISeriesApi<'Line'>;
  upper: ISeriesApi<'Line'>;
  lower: ISeriesApi<'Line'>;
  markers: ISeriesMarkersPluginApi<Time>;
}

const ts = (t: number) => t as UTCTimestamp;
const toDate = (t: Time) => new Date((t as number) * 1000);

/**
 * The bot's own chart, drawn with TradingView's Lightweight Charts from the exact candles
 * the bot evaluates, with its buys, sells, stop and target overlaid.
 */
export function BotChart({ symbol, emptyText }: { symbol: string; emptyText: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Series | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const theme = useStore((s) => s.theme);
  const interval = useStore((s) => s.interval);
  const fills = useStore((s) => s.fills);
  const position = useStore((s) => s.positions.find((p) => p.symbol === symbol));
  const [showBands, setShowBands] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [hasData, setHasData] = useState(() => hub.candles(symbol).length > 0);
  const [dataVersion, setDataVersion] = useState(0);

  // Create the chart once.
  useEffect(() => {
    const t = readTokens();
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font, fontSize: 12, attributionLogo: true },
      grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
      rightPriceScale: { borderColor: t.line },
      timeScale: {
        borderColor: t.line,
        timeVisible: true,
        rightOffset: 6,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const d = toDate(time);
          switch (type) {
            case TickMarkType.Year:
              return String(d.getFullYear());
            case TickMarkType.Month:
              return d.toLocaleDateString([], { month: 'short' });
            case TickMarkType.DayOfMonth:
              return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
            case TickMarkType.TimeWithSeconds:
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            default:
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        },
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (time: Time) => toDate(time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const fast = chart.addSeries(LineSeries, { ...line, color: t.accent, lineWidth: 2 });
    const slow = chart.addSeries(LineSeries, { ...line, color: t.focus, lineWidth: 2 });
    const upper = chart.addSeries(LineSeries, { ...line, color: t.text, lineStyle: LineStyle.Dotted, visible: false });
    const lower = chart.addSeries(LineSeries, { ...line, color: t.text, lineStyle: LineStyle.Dotted, visible: false });
    const markers = createSeriesMarkers(candles, []);
    chartRef.current = chart;
    seriesRef.current = { candles, volume, fast, slow, upper, lower, markers };
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  // Theme.
  useEffect(() => {
    const chart = chartRef.current;
    const s = seriesRef.current;
    if (!chart || !s) return;
    const t = readTokens();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font },
      grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
      rightPriceScale: { borderColor: t.line },
      timeScale: { borderColor: t.line },
    });
    s.candles.applyOptions({ upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down });
    s.fast.applyOptions({ color: t.accent });
    s.slow.applyOptions({ color: t.focus });
    s.upper.applyOptions({ color: t.text });
    s.lower.applyOptions({ color: t.text });
    setDataVersion((v) => v + 1); // recolour volume bars
  }, [theme]);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ secondsVisible: interval === '1s' });
  }, [interval]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.upper.applyOptions({ visible: showBands });
    s.lower.applyOptions({ visible: showBands });
    s.volume.applyOptions({ visible: showVolume });
  }, [showBands, showVolume]);

  // Data: full load on symbol change, cheap per-tick updates afterwards.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    let precision = -1;

    const volColor = (c: Candle, t: ReturnType<typeof readTokens>) => (c.close >= c.open ? t.upSoft : t.downSoft);

    const full = () => {
      const bars = hub.candles(symbol);
      const t = readTokens();
      setHasData(bars.length > 0);
      if (!bars.length) {
        for (const x of [s.candles, s.volume, s.fast, s.slow, s.upper, s.lower]) x.setData([]);
        return;
      }
      const p = priceDecimals(bars[bars.length - 1].close);
      if (p !== precision) {
        precision = p;
        s.candles.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: 1 / 10 ** p } });
      }
      const closes = bars.map((b) => b.close);
      const f = ema(closes, 9);
      const sl = ema(closes, 21);
      const bb = bollinger(closes, 20, 2);
      const line = (vals: number[]) => bars.flatMap((b, i) => (Number.isFinite(vals[i]) ? [{ time: ts(b.time), value: vals[i] }] : []));
      s.candles.setData(bars.map((b) => ({ time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
      s.volume.setData(bars.map((b) => ({ time: ts(b.time), value: b.volume, color: volColor(b, t) })));
      s.fast.setData(line(f));
      s.slow.setData(line(sl));
      s.upper.setData(line(bb.upper));
      s.lower.setData(line(bb.lower));
      setDataVersion((v) => v + 1);
    };

    const tick = () => {
      const bars = hub.candles(symbol);
      const b = bars[bars.length - 1];
      if (!b) return;
      if (bars.length === 1) return full();
      const t = readTokens();
      const time = ts(b.time);
      s.candles.update({ time, open: b.open, high: b.high, low: b.low, close: b.close });
      s.volume.update({ time, value: b.volume, color: volColor(b, t) });
      const closes = bars.slice(-120).map((x) => x.close);
      const f = ema(closes, 9);
      const sl = ema(closes, 21);
      const bb = bollinger(closes, 20, 2);
      const lastOf = (a: number[]) => a[a.length - 1];
      if (Number.isFinite(lastOf(f))) s.fast.update({ time, value: lastOf(f) });
      if (Number.isFinite(lastOf(sl))) s.slow.update({ time, value: lastOf(sl) });
      if (Number.isFinite(lastOf(bb.upper))) {
        s.upper.update({ time, value: lastOf(bb.upper) });
        s.lower.update({ time, value: lastOf(bb.lower) });
      }
    };

    full();
    return hub.watch(symbol, (isFull) => (isFull ? full() : tick()));
  }, [symbol, interval, theme]);

  useEffect(() => {
    chartRef.current?.timeScale().scrollToRealTime();
  }, [symbol, interval]);

  // Trade markers.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const bars = hub.candles(symbol);
    if (!bars.length) return s.markers.setMarkers([]);
    const sec = intervalSeconds(interval);
    const first = bars[0].time;
    const t = readTokens();
    const marks: SeriesMarker<Time>[] = fills
      .filter((f) => f.symbol === symbol)
      .map((f) => ({ ...f, bar: Math.floor(f.time / 1000 / sec) * sec }))
      .filter((f) => f.bar >= first)
      .map((f) => ({
        time: ts(f.bar),
        position: f.action === 'buy' ? 'belowBar' : 'aboveBar',
        shape: f.action === 'buy' ? 'arrowUp' : 'arrowDown',
        color: f.action === 'buy' ? t.up : t.down,
        text: `${f.action === 'buy' ? 'Buy' : 'Sell'}${f.by === 'manual' ? ' (you)' : ''}`,
      }));
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    s.markers.setMarkers(marks);
  }, [fills, symbol, interval, dataVersion]);

  // Entry, stop and target lines for an open position.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const l of linesRef.current) s.candles.removePriceLine(l);
    linesRef.current = [];
    if (!position) return;
    const t = readTokens();
    const add = (price: number, color: string, title: string, style: LineStyle) =>
      linesRef.current.push(s.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    add(position.entryPrice, t.text, position.side === 'long' ? 'Entry' : 'Short entry', LineStyle.Solid);
    if (position.stopLoss) add(position.stopLoss, t.down, position.stopLoss > position.entryPrice === (position.side === 'long') ? 'Trail stop' : 'Stop', LineStyle.Dashed);
    if (position.takeProfit) add(position.takeProfit, t.up, 'Target', LineStyle.Dashed);
  }, [position, theme, symbol]);

  return (
    <div className="chart-body">
      <div className="chart-legend" aria-hidden="true">
        <span>
          <i style={{ background: 'var(--accent)' }} />
          EMA 9
        </span>
        <span>
          <i style={{ background: 'var(--focus)' }} />
          EMA 21
        </span>
        {showBands && (
          <span>
            <i style={{ background: 'var(--muted)' }} />
            Bollinger 20, 2
          </span>
        )}
        {position && (
          <span>
            Entry {fmtPrice(position.entryPrice)}
          </span>
        )}
      </div>
      <div className="chart-toggles">
        <button className="chip-toggle" aria-pressed={showBands} onClick={() => setShowBands((v) => !v)}>
          Bands
        </button>
        <button className="chip-toggle" aria-pressed={showVolume} onClick={() => setShowVolume((v) => !v)}>
          Volume
        </button>
      </div>
      <div className="chart-canvas" ref={el} />
      {!hasData && <div className="chart-empty">{emptyText}</div>}
    </div>
  );
}
