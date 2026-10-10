'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { pricePrecision } from '@/lib/format';
import type { KlinePoint } from '@/lib/market/types';

const UP = '#0ecb81';
const DOWN = '#f6465d';

export function KlineChart({
  data,
  height = 340,
}: {
  data: KlinePoint[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  // 初始化图表（仅一次）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#848e9c',
        fontSize: 11,
        fontFamily:
          "var(--font-geist-sans), ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: 'rgba(43, 49, 57, 0.45)' },
        horzLines: { color: 'rgba(43, 49, 57, 0.45)' },
      },
      rightPriceScale: { borderColor: '#2b3139' },
      timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      localization: {
        priceFormatter: undefined,
      },
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    candleRef.current = candle;

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = vol;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, []);

  // 数据填充
  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candle || !vol || !chart || data.length === 0) return;

    // +8h 偏移，使 UTC 渲染的时轴显示北京时间 (UTC+8)
    const shift = 8 * 3600;
    const candles = data.map((k) => ({
      time: (Math.floor(k.t / 1000) + shift) as UTCTimestamp,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
    }));
    const volumes = data.map((k) => ({
      time: (Math.floor(k.t / 1000) + shift) as UTCTimestamp,
      value: k.qv,
      color: k.c >= k.o ? 'rgba(14, 203, 129, 0.45)' : 'rgba(246, 70, 93, 0.45)',
    }));
    candle.setData(candles);
    vol.setData(volumes);
    chart.timeScale().fitContent();

    const last = data[data.length - 1];
    const { precision, minMove } = pricePrecision(last.c);
    candle.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
  }, [data]);

  const lastPrice = useMemo(() => (data.length ? data[data.length - 1].c : 0), [data]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {data.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          K 线加载中…
        </div>
      )}
      {data.length > 0 && (
        <div className="pointer-events-none absolute left-2 top-1 text-xs tabular-nums text-muted-foreground">
          O <span className="text-foreground">{lastPrice > 0 ? data[data.length - 1].o : '—'}</span>
          <span className="ml-2">C</span>{' '}
          <span className={data[data.length - 1].c >= data[data.length - 1].o ? 'text-up' : 'text-down'}>
            {lastPrice}
          </span>
        </div>
      )}
    </div>
  );
}
