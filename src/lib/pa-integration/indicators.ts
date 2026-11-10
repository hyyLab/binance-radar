/**
 * 指标与逐棒几何特征（自 PA Agent Web src/lib/pa/indicators.ts 移植——已验证实现，任务书
 * §2「优先复用」；仅 Bar 类型来源改为 pa-integration 的 PaBar，算法逐行一致：
 * EMA / Wilder ATR14 / 量比 / 棒型 / EMA 相对位置 / 重叠度 / seq 编号 K1=最新已收盘）。
 * 输入 bars 为升序（旧→新），全部为已收盘 K 线。
 */
import type { PaBar } from './kline-aggregator';

/** EMA（周期 period），返回与输入等长的数组，暖机期为 null */
export function ema(values: number[], period: number): (number | null)[] {
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

/** Wilder ATR14，暖机期为 null */
export function atr14(bars: { high: number; low: number; close: number }[], period = 14): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs: number[] = [0];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trs.push(tr);
  }
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += trs[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** 20 周期均量（不含当根），暖机期 null */
export function volumeRatio(bars: { volume: number }[], i: number, period = 20): number | null {
  if (i < period) return null;
  let sum = 0;
  for (let j = i - period; j < i; j++) sum += bars[j].volume;
  const avg = sum / period;
  if (avg <= 0) return null;
  return bars[i].volume / avg;
}

export type BarType =
  | '趋势阳线' | '趋势阴线' | '十字星' | '内包线' | '平线' | '普通';

export function barType(b: { open: number; high: number; low: number; close: number }): BarType {
  const range = b.high - b.low;
  if (range <= 1e-9) return '平线';
  const body = Math.abs(b.close - b.open);
  const bull = b.close > b.open;
  if (body / range >= 0.7) return bull ? '趋势阳线' : '趋势阴线';
  if (body / range <= 0.1) return '十字星';
  if (b.high <= Math.max(b.open, b.close) && b.low >= Math.min(b.open, b.close)) return '内包线';
  return '普通';
}

export interface BarFeature {
  seq: number; // 1 = 最新已收盘K线
  ts: number;
  o: number; h: number; l: number; c: number;
  barType: BarType;
  bodyRatio: number; // 实体/区间
  rangeAtr: number | null; // 区间/ATR14
  emaRel: '上方' | '下方' | '附近' | '-';
  overlapPrev: number | null; // 与前一根的重叠比例
  volRatio: number | null;
  volState: '放量' | '常量' | '缩量' | '-';
  closed: boolean;
}

export interface FeatureBundle {
  features: BarFeature[]; // 升序（旧→新）
  ema20: (number | null)[];
  atr14: (number | null)[];
  lastClose: number;
  lastAtr: number | null;
  emaSlope20: number | null; // 最近10根 EMA20 斜率（相对价格%）
}

/** 计算全部逐棒特征；bars 升序且全部已收盘 */
export function computeFeatures(bars: PaBar[]): FeatureBundle {
  const closes = bars.map((b) => b.close);
  const ema20 = ema(closes, 20);
  const atr = atr14(bars, 14);
  const features: BarFeature[] = bars.map((b, i) => {
    const range = Math.max(b.high - b.low, 1e-9);
    const bodyRatio = Math.abs(b.close - b.open) / range;
    const a = atr[i];
    const e = ema20[i];
    let emaRel: BarFeature['emaRel'] = '-';
    if (e != null && a != null && a > 0) {
      const dist = (b.close - e) / a;
      emaRel = dist > 0.3 ? '上方' : dist < -0.3 ? '下方' : '附近';
    }
    let overlapPrev: number | null = null;
    if (i > 0) {
      const p = bars[i - 1];
      const lo = Math.max(b.low, p.low);
      const hi = Math.min(b.high, p.high);
      const prevRange = Math.max(p.high - p.low, 1e-9);
      overlapPrev = Math.max(0, hi - lo) / prevRange;
    }
    const vr = volumeRatio(bars, i);
    const volState: BarFeature['volState'] =
      vr == null ? '-' : vr >= 1.5 ? '放量' : vr <= 0.6 ? '缩量' : '常量';
    // seq：与 pa_agent 一致——升序输入时最新一根 = K1，往前递增
    const seq = bars.length - i;
    return {
      seq,
      ts: b.ts,
      o: b.open, h: b.high, l: b.low, c: b.close,
      barType: barType(b),
      bodyRatio,
      rangeAtr: a && a > 0 ? (b.high - b.low) / a : null,
      emaRel,
      overlapPrev,
      volRatio: vr,
      volState,
      closed: b.closed,
    };
  });
  const lastClose = closes[closes.length - 1] ?? 0;
  const lastAtr = atr[atr.length - 1] ?? null;
  let emaSlope20: number | null = null;
  const e1 = ema20[ema20.length - 1];
  const e11 = ema20[ema20.length - 11];
  if (e1 != null && e11 != null && e11 !== 0) {
    emaSlope20 = ((e1 - e11) / e11) * 100;
  }
  return { features, ema20, atr14: atr, lastClose, lastAtr, emaSlope20 };
}

/** 组装给 LLM 的紧凑逐棒文本（旧→新，K1=最新已收盘） */
export function featuresToPromptTable(features: BarFeature[], maxBars = 100): string {
  const rows = features.slice(-maxBars);
  const lines = rows.map((f) => {
    const seqStr = `K${f.seq}`;
    const parts = [
      seqStr,
      `O${fmt(f.o)} H${fmt(f.h)} L${fmt(f.l)} C${fmt(f.c)}`,
      f.barType,
      `实体比${f.bodyRatio.toFixed(2)}`,
      f.rangeAtr != null ? `振幅${f.rangeAtr.toFixed(1)}xATR` : '',
      `EMA20${f.emaRel}`,
      f.overlapPrev != null ? `重叠${(f.overlapPrev * 100).toFixed(0)}%` : '',
      `量能:${f.volState}`,
    ].filter(Boolean);
    return parts.join(' | ');
  });
  return lines.join('\n');
}

function fmt(x: number): string {
  if (Math.abs(x) >= 1000) return x.toFixed(1);
  if (Math.abs(x) >= 1) return x.toFixed(3);
  return x.toFixed(5);
}
