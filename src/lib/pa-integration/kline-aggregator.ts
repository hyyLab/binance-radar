// ---------- PA 整合 · 1m→5m/15m K 线聚合（任务书 §四） ----------
// 纪律：
// - 只使用已收盘 1m K 线（KlineStore.closedCandles 已过滤）；
// - 桶完整性校验：5m 桶必须含 5 根连续 1m（15m 桶 15 根），缺失 → 该桶丢弃（绝不把缺
//   K 线的周期当成完整周期）；
// - 输出升序（旧→新），与 PA KlineFrame 顺序一致（radar 1m 升序，聚合保持升序，
//   PA Web indicators 直接消费升序——无排序翻转需求，但此约束在此显式声明）；
// - OHLC/V 聚合：o=首根 open，c=末根 close，h=max，l=min，qv/volume 求和。

import type { Candle1m } from '@/lib/market/enhanced/klines';

/** PA 分析用 K 线（与 PA Web Bar 同形） */
export interface PaBar {
  ts: number; // 开盘时间 ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 基础币量近似（qv/price 近似；PA 特征只用相对量能）
  closed: boolean;
  pct_chg?: number | null;
  qv: number; // 计价成交额 USDT
}

export interface AggregateResult {
  bars: PaBar[];
  /** 因 1m 缺失被丢弃的桶数（数据完整性指标） */
  droppedBuckets: number;
  /** 输入窗口内最早/最晚已收盘 1m 时间（新鲜度判定用） */
  firstT: number | null;
  lastT: number | null;
}

/**
 * 将升序已收盘 1m K 线聚合为 minutes 周期。
 * @param candles 已收盘 1m（升序；来自 KlineStore.closedCandles）
 * @param minutes 目标周期分钟数（5 / 15）
 * @param targetBars 目标产出根数（不足时从最新往回取完整桶）
 */
export function aggregateFrom1m(candles: Candle1m[], minutes: number, targetBars: number): AggregateResult {
  const bucketMs = minutes * 60_000;
  const buckets = new Map<number, Candle1m[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / bucketMs) * bucketMs;
    const arr = buckets.get(key);
    if (arr) arr.push(c);
    else buckets.set(key, [c]);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const bars: PaBar[] = [];
  let droppedBuckets = 0;
  for (const key of keys) {
    const group = buckets.get(key)!;
    // 桶完整性：桶内 1m 根数 = 周期分钟数（closedCandles 已保证只含已收盘，跨桶边界
    // 未收满的桶自然少于 minutes → 丢弃）
    if (group.length < minutes) {
      droppedBuckets++;
      continue;
    }
    let hasGap = false;
    for (let i = 1; i < group.length; i++) {
      if (group[i].t !== group[i - 1].t + 60_000) {
        hasGap = true;
        break;
      }
    }
    if (hasGap) {
      droppedBuckets++;
      continue;
    }
    let high = -Infinity;
    let low = Infinity;
    let qv = 0;
    let volume = 0;
    for (const c of group) {
      if (c.h > high) high = c.h;
      if (c.l < low) low = c.l;
      qv += c.qv;
      volume += c.qv / (c.c > 0 ? c.c : 1); // 近似基础币量
    }
    bars.push({
      ts: key,
      open: group[0].o,
      high,
      low,
      close: group[group.length - 1].c,
      volume,
      closed: true,
      qv,
      pct_chg: null,
    });
  }

  const trimmed = bars.slice(-targetBars);
  return {
    bars: trimmed,
    droppedBuckets,
    firstT: trimmed.length ? trimmed[0].ts : null,
    lastT: trimmed.length ? trimmed[trimmed.length - 1].ts : null,
  };
}

/** 期望完整 1m 根数（含聚合所需余量） */
export function required1mCount(minutes: number, targetBars: number): number {
  return minutes * targetBars + minutes; // 多留一个桶的余量
}
