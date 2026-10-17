// ---------- 趋势识别 · 高波动品种特征指标（Task 54） ----------
// 输入一律为「已收盘 K 线」（UTE toClosedBars 产物），绝不使用未收盘 bar 参与计算。
// 本模块只做特征计算（证据），不产生方向结论——方向判定统一由 UTE assessTrend 输出，
// 结束判定由 lifecycle.ts 消费这里的特征完成（单一趋势算法来源纪律）。
//
// 指标清单（任务 §2.2）：
// - ATR / ATR%：衡量不同币种、不同阶段的波动幅度
// - 实现波动率 + 分位：区分正常 / 高波动 / 极端波动状态
// - Efficiency Ratio：区分持续单向运动与反复震荡
// - 影线特征 / 假突破：识别插针与快速回落
// 全部为纯函数，便于回放复用（scripts/replay 直接 import 本模块）。

import type { Bar } from 'universal-trend-engine';

/** 波动率状态（分位 + 绝对下限双门槛，阈值集中于 config） */
export type VolRegime = 'NORMAL' | 'HIGH' | 'EXTREME';

export interface VolatilityFeatures {
  /** ATR(14) 绝对值（计价单位） */
  atr: number;
  /** ATR 占价比（atr / close × 100，%）——跨币种可比的波动幅度 */
  atrPct: number;
  /** 已实现波动率（最近 rvWindowBars 根 1m 对数收益标准差，年化省略、按日化 % 表达） */
  realizedVolPct: number;
  /** 上述 RV 在自身近期历史中的分位（0-1；样本不足返回 -1 并由 valid 标记） */
  volPercentile: number;
  /** 波动状态分类 */
  volRegime: VolRegime;
  /** 方向效率 ER（|净位移| / Σ|逐根位移|，0-1；越高越「单边」，越低越「震荡」） */
  efficiencyRatio: number;
  /** 最近一根的上下影线占比（0-1，占整根 range） */
  upperWickPct: number;
  lowerWickPct: number;
  /** 突破标记（最近收盘价相对前 lookbackBars-1 根高/低点） */
  breakout: 'up' | 'down' | 'none';
  /** 假突破：最近 breakAttemptBars 根内曾越出区间但收盘收回区间内 */
  falseBreakout: boolean;
  /** 参与计算的有效 bar 数（供数据充分性判定） */
  barsUsed: number;
}

export interface IndicatorConfig {
  atrBars: number; // ATR 窗口
  rvWindowBars: number; // 实现波动率窗口
  rvSampleBars: number; // RV 历史分位采样总长度
  erBars: number; // ER 窗口
  erFloor: number; // 结构失效 ER 下限（lifecycle 证据 C 用）
  breakAttemptBars: number; // 假突破回看根数
  highPct: number; // volPercentile ≥ 该值 → HIGH
  extremePct: number; // ≥ 该值 → EXTREME
}

export const DEFAULT_INDICATOR_CFG: IndicatorConfig = {
  atrBars: 14,
  rvWindowBars: 60,
  rvSampleBars: 240,
  erBars: 12,
  erFloor: 0.25,
  breakAttemptBars: 3,
  highPct: 0.8,
  extremePct: 0.95,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Wilder 式 ATR（首值 = 前 atrBars 根 TR 简单均值，其后平滑） */
export function atrOf(bars: Bar[], period: number): number {
  if (bars.length < period + 1) return 0;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    sum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  let atr = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

/** 日化已实现波动率 %：std(log return) × √(每日 1m 根数 1440) × 100 */
export function realizedVolPct(bars: Bar[], window: number): number {
  if (bars.length < window + 1) return 0;
  const rets: number[] = [];
  for (let i = bars.length - window; i < bars.length; i++) {
    rets.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const varr = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * Math.sqrt(1440) * 100;
}

/** Kaufman Efficiency Ratio（窗口内 |净位移| / Σ|逐根位移|；分母 0 → 0） */
export function efficiencyRatio(bars: Bar[], window: number): number {
  if (bars.length < window + 1) return 0;
  const seg = bars.slice(-(window + 1));
  const net = Math.abs(seg[seg.length - 1].close - seg[0].close);
  let path = 0;
  for (let i = 1; i < seg.length; i++) path += Math.abs(seg[i].close - seg[i - 1].close);
  return path > 0 ? clamp01(net / path) : 0;
}

/** RV 历史分位：当前窗口 RV 在过去 rvSampleBars 内每 rvWindowBars 段 RV 样本中的秩 */
function rvPercentile(bars: Bar[], cfg: IndicatorConfig): number {
  const cur = realizedVolPct(bars, cfg.rvWindowBars);
  const samples: number[] = [];
  const segEnd = bars.length - cfg.rvWindowBars; // 排除当前窗口
  for (let end = segEnd; end >= cfg.rvWindowBars + 1; end -= cfg.rvWindowBars) {
    samples.push(realizedVolPct(bars.slice(0, end), cfg.rvWindowBars));
    if (samples.length >= Math.floor(cfg.rvSampleBars / cfg.rvWindowBars)) break;
  }
  if (samples.length < 3) return -1; // 样本不足：分位不可用（调用方按 -1 处理，不伪造）
  const below = samples.filter((s) => s <= cur).length;
  return below / samples.length;
}

/** 主入口：由已收盘 1m bars 计算全部特征。数据不足时字段尽力计算、barsUsed 如实返回 */
export function computeVolatilityFeatures(
  closed: Bar[],
  cfg: IndicatorConfig = DEFAULT_INDICATOR_CFG,
): VolatilityFeatures {
  const n = closed.length;
  if (n === 0) {
    return {
      atr: 0, atrPct: 0, realizedVolPct: 0, volPercentile: -1, volRegime: 'NORMAL',
      efficiencyRatio: 0, upperWickPct: 0, lowerWickPct: 0, breakout: 'none',
      falseBreakout: false, barsUsed: 0,
    };
  }
  const last = closed[n - 1];
  const atr = atrOf(closed, cfg.atrBars);
  const rv = realizedVolPct(closed, cfg.rvWindowBars);
  const pct = rvPercentile(closed, cfg);
  // 波动状态：分位主判 + 绝对日化下限兜底（分位不可用时不伪装为高波动）
  let regime: VolRegime = 'NORMAL';
  if (pct >= 0) {
    if (pct >= cfg.extremePct && rv >= 50) regime = 'EXTREME';
    else if (pct >= cfg.highPct && rv >= 25) regime = 'HIGH';
  } else if (rv >= 100) regime = 'EXTREME';

  // 影线占比
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  const upperWickPct = range > 0 ? upper / range : 0;
  const lowerWickPct = range > 0 ? lower / range : 0;

  // 突破 / 假突破（回看 breakAttemptBars 根，任一根曾越出前区间但收盘收回）
  const prior = closed.slice(Math.max(0, n - cfg.breakAttemptBars - 1), n - 1);
  const priorHigh = prior.length > 0 ? Math.max(...prior.map((b) => b.high)) : last.high;
  const priorLow = prior.length > 0 ? Math.min(...prior.map((b) => b.low)) : last.low;
  let breakout: 'up' | 'down' | 'none' = 'none';
  if (last.close > priorHigh) breakout = 'up';
  else if (last.close < priorLow) breakout = 'down';
  let falseBreakout = false;
  for (let i = Math.max(1, n - cfg.breakAttemptBars); i < n; i++) {
    const b = closed[i];
    const before = closed.slice(Math.max(0, i - cfg.atrBars), i);
    if (before.length === 0) continue;
    const hi = Math.max(...before.map((x) => x.high));
    const lo = Math.min(...before.map((x) => x.low));
    const backInside = b.close <= hi && b.close >= lo;
    if ((b.high > hi || b.low < lo) && backInside && b.close < b.high && b.close > b.low) {
      // 曾刺出区间且收盘收回（非单边收在区间外）→ 视为假突破迹象
      const pierced = b.high > hi || b.low < lo;
      if (pierced && !(b.close > hi || b.close < lo)) falseBreakout = true;
    }
  }

  return {
    atr,
    atrPct: last.close > 0 ? (atr / last.close) * 100 : 0,
    realizedVolPct: rv,
    volPercentile: pct,
    volRegime: regime,
    efficiencyRatio: efficiencyRatio(closed, cfg.erBars),
    upperWickPct,
    lowerWickPct,
    breakout,
    falseBreakout,
    barsUsed: n,
  };
}

// ============ 高周期聚合（1m → 5m / 15m，任务 §2.2） ============
// 从足够长的已收盘 1m 历史聚合高周期 bar；bucket 按 openTime 对齐，只保留完整 bucket
//（当前未走完的 bucket 丢弃——绝不拿不完整的高周期 bar 冒充有效确认）。

export function aggregateBars(closed1m: Bar[], factor: number): Bar[] {
  const bucketMs = factor * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curBucket = -1;
  for (const b of closed1m) {
    const bucket = Math.floor(b.time / bucketMs) * bucketMs; // b.time = 1m 收盘时刻
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = { time: bucket + bucketMs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  // 只保留「整 bucket 已收盘」的 bar：最后一个 bucket 若尚未走完（相对 now）由调用方以
  // bars 的 time（= bucket 末尾）对照 now 判定；此处统一按调用方传入的 now 过滤
  return out;
}

export interface HtfAssessment {
  /** UTE 评估方向（无状态 assessment，不维护高周期状态机） */
  dir: 'up' | 'down' | 'flat';
  efficiencyRatio: number;
  returnPct: number;
  /** 已收盘高周期 bar 数是否达到最小确认要求（不足时 valid=false，不得冒充有效过滤） */
  valid: boolean;
  bars: number;
}

export const HTF_MIN_BARS = 16; // = UTE minBars（lookback 12 + 1 余量）

/** 高周期趋势过滤评估：对聚合后的高周期 bars 跑 UTE assessTrend（config 独立传入） */
export function assessHtf(
  closed1m: Bar[],
  factor: number,
  now: number,
  cfg: { lookbackBars: number; minMovePct: number },
  assess: (bars: Bar[], opts: { now: number }) => { direction: 'up' | 'down' | 'flat'; features?: { returnPct: number } },
): HtfAssessment {
  const agg = aggregateBars(closed1m, factor).filter((b) => b.time <= now);
  if (agg.length < HTF_MIN_BARS) {
    return { dir: 'flat', efficiencyRatio: 0, returnPct: 0, valid: false, bars: agg.length };
  }
  const r = assess(agg, { now });
  return {
    dir: r.direction,
    efficiencyRatio: efficiencyRatio(agg, cfg.lookbackBars),
    returnPct: r.features?.returnPct ?? 0,
    valid: true,
    bars: agg.length,
  };
}
