// ---------- PA 整合 · 标记价读取（多源供价，动态解析活跃采集器） ----------
// 与 paper.ts 同纪律：经 globalThis 稳定别名动态解析活跃 futures collector，
// 不依赖模块图捕获的旧绑定（Task 44 规则）。

import { activeFuturesCollector } from '@/lib/market/futures-collector';

function liveFuturesCollector(): ReturnType<typeof activeFuturesCollector> {
  const g = globalThis as typeof globalThis & {
    __binanceRadarFuturesActive?: ReturnType<typeof activeFuturesCollector>;
  };
  return g.__binanceRadarFuturesActive ?? activeFuturesCollector();
}

/** 合约标记价（不可用时返回 0；调用方按 WAIT/跳过处理） */
export function liveFuturesMark(symbol: string): number {
  try {
    const t = liveFuturesCollector().getTickers().find((x) => x.symbol === symbol);
    return t ? t.price : 0;
  } catch {
    return 0;
  }
}

/** 24h 计价成交额快照（流动性展示用） */
export function liveFuturesQuoteVolume24h(symbol: string): number {
  try {
    const t = liveFuturesCollector().getTickers().find((x) => x.symbol === symbol);
    return t?.quoteVolume24h ?? 0;
  } catch {
    return 0;
  }
}

/** 合约 tickSize（仪器清单 PRICE_FILTER；清单缺失返回 0，由调用方兜底） */
export function liveFuturesTickSize(symbol: string): number {
  try {
    return liveFuturesCollector().tickSizeOf(symbol);
  } catch {
    return 0;
  }
}
