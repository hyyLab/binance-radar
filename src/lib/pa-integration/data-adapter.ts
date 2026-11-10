// ---------- PA 整合 · 行情数据适配（任务书 §四） ----------
// 只读消费 radar 已有缓存，绝不重复请求相同行情：
// - 1m：KlineStore（UTE 同源缓存）
// - 5m/15m：本模块按需聚合（96/32 根已收盘）
// - 标记价/24h 额：futures collector tickers
// - tickSize：futures collector 仪器清单 PRICE_FILTER（非小数位猜测）
// - 数据不完整/过期 → 返回 wait=true（任务书：WAIT，不允许继续生成交易计划）

import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { liveFuturesMark, liveFuturesTickSize } from './market-snapshot';
import { aggregateFrom1m, required1mCount, type PaBar } from './kline-aggregator';

/** 分析窗口目标（任务书 §四） */
export const PA_WINDOW = {
  bars5m: 96, // 5m 主分析
  bars15m: 32, // 15m 背景
} as const;

/** 数据最大年龄：5m 最后一根收盘时间距 now 超过该值 → 视为过期（radar 1m 轮换 5min/标的） */
const FIVE_MIN_STALE_MS = 15 * 60_000;
const FIFTEEN_MIN_STALE_MS = 30 * 60_000;

export interface PaMarketSnapshot {
  symbol: string;
  ok: boolean;
  waitReason: string | null;
  mark: number;
  tickSize: number;
  bars5m: PaBar[];
  bars15m: PaBar[];
  barTime5m: number | null; // 最新已收盘 5m 开盘时间（幂等键）
  barTime15m: number | null;
  droppedBuckets: number;
  ts: number;
}

/**
 * 构建 PA 分析所需行情快照。
 * 注意：KlineStore 只跟踪观察池标的——异动/热门/扫描器来源的币种若未入池，缓存可能为空；
 * 此时由调用方决定是否触发 store.backfill（PA 扫描层限频触发，本模块保持只读）。
 */
export async function buildPaMarketSnapshot(
  symbol: string,
  opts?: { triggerBackfill?: boolean },
): Promise<PaMarketSnapshot> {
  const now = Date.now();
  const fail = (waitReason: string): PaMarketSnapshot => ({
    symbol,
    ok: false,
    waitReason,
    mark: 0,
    tickSize: 0,
    bars5m: [],
    bars15m: [],
    barTime5m: null,
    barTime15m: null,
    droppedBuckets: 0,
    ts: now,
  });

  const mark = liveFuturesMark(symbol);
  if (!(mark > 0)) return fail('标记价不可用（合约行情未就绪）');

  const engine = getEnhancedEngine();
  let needBackfill = false;
  if (!engine.store.has(symbol)) {
    needBackfill = true;
  } else {
    const lookback = required1mCount(15, PA_WINDOW.bars15m); // 覆盖两个周期
    const have = engine.store.closedCandles(symbol, lookback, now).length;
    if (have < required1mCount(5, 24)) needBackfill = true; // 少于 2h 数据 → 尝试补
  }
  if (needBackfill && opts?.triggerBackfill) {
    try {
      await engine.store.backfill(symbol);
    } catch {
      /* 回填失败按数据不足处理 */
    }
  }

  const lookbackMs = required1mCount(15, PA_WINDOW.bars15m) * 60_000;
  const closed1m = engine.store.has(symbol) ? engine.store.closedCandles(symbol, lookbackMs, now) : [];
  if (closed1m.length < required1mCount(5, 12)) {
    return fail(`1m 缓存不足（${closed1m.length} 根，聚合 5m 至少需要 ${required1mCount(5, 12)} 根）`);
  }

  const agg5 = aggregateFrom1m(closed1m, 5, PA_WINDOW.bars5m);
  const agg15 = aggregateFrom1m(closed1m, 15, PA_WINDOW.bars15m);

  if (agg5.bars.length < 24) return fail(`5m 完整桶不足（${agg5.bars.length}/24 最低要求）`);
  if (agg15.bars.length < 12) return fail(`15m 完整桶不足（${agg15.bars.length}/12 最低要求）`);

  const last5 = agg5.bars[agg5.bars.length - 1];
  const last15 = agg15.bars[agg15.bars.length - 1];
  const stale5 = now - (last5.ts + 5 * 60_000) > FIVE_MIN_STALE_MS;
  const stale15 = now - (last15.ts + 15 * 60_000) > FIFTEEN_MIN_STALE_MS;
  if (stale5) return fail(`5m 数据过期（最新收盘 ${new Date(last5.ts + 300_000).toISOString()}）`);
  if (stale15) return fail('15m 数据过期');

  // tickSize：仪器清单优先；无清单时按价格量级保守兜底（仅用于校验与展示）
  let tickSize = liveFuturesTickSize(symbol);
  if (!(tickSize > 0)) {
    const p = mark;
    tickSize = p >= 1000 ? 0.1 : p >= 100 ? 0.01 : p >= 1 ? 0.001 : p >= 0.1 ? 0.0001 : 0.00001;
  }

  return {
    symbol,
    ok: true,
    waitReason: null,
    mark,
    tickSize,
    bars5m: agg5.bars,
    bars15m: agg15.bars,
    barTime5m: last5.ts,
    barTime15m: last15.ts,
    droppedBuckets: agg5.droppedBuckets + agg15.droppedBuckets,
    ts: now,
  };
}
