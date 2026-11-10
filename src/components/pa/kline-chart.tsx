'use client';

// ---------- PA 详情面板 · K 线图（5m/15m + EMA20 + 交易计划价格线） ----------
// lightweight-charts v5 API（与现有 kline-chart.tsx 同源用法）；
// 价格线与交易计划数据严格一致（entry/SL/TP1/TP2）。

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';

export interface KlinePoint {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PlanLines {
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit1?: number | null;
  takeProfit2?: number | null;
}

function emaSeries(values: number[], period = 20): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export default function PaKlineChart(props: {
  title: string;
  points: KlinePoint[];
  plan?: PlanLines | null;
  height?: number;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: props.height ?? 260,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(148,163,184,0.2)' },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
      autoSize: true,
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a', downColor: '#dc2626', borderUpColor: '#16a34a', borderDownColor: '#dc2626',
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
    const ema = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    chartRef.current = chart;
    candleRef.current = candle;
    emaRef.current = ema;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRef.current = null;
    };
     
  }, []);

  useEffect(() => {
    const candle = candleRef.current;
    const ema = emaRef.current;
    const chart = chartRef.current;
    if (!candle || !ema || !chart || props.points.length === 0) return;
    const bars = props.points.map((p) => ({
      time: (p.t / 1000) as UTCTimestamp,
      open: p.o, high: p.h, low: p.l, close: p.c,
    }));
    candle.setData(bars);
    const closes = props.points.map((p) => p.c);
    const emaVals = emaSeries(closes, 20);
    ema.setData(
      props.points
        .map((p, i) => ({ time: (p.t / 1000) as UTCTimestamp, value: emaVals[i] }))
        .filter((x): x is { time: UTCTimestamp; value: number } => x.value != null),
    );

    // 交易计划价格线（与计划数据严格一致）
    const plan = props.plan ?? {};
    const lineDefs: { price: number | null | undefined; color: string; title: string }[] = [
      { price: plan.entry, color: '#38bdf8', title: 'Entry' },
      { price: plan.stopLoss, color: '#ef4444', title: 'SL' },
      { price: plan.takeProfit1, color: '#22c55e', title: 'TP1' },
      { price: plan.takeProfit2, color: '#10b981', title: 'TP2' },
    ];
    for (const d of lineDefs) {
      if (d.price == null || !Number.isFinite(d.price) || d.price <= 0) continue;
      candle.createPriceLine({ price: d.price, color: d.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: d.title });
    }
    chart.timeScale().fitContent();
     
  }, [props.points, props.plan]);

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{props.title}</div>
      <div ref={elRef} className="w-full" />
    </div>
  );
}
