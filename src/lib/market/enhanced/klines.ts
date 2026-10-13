// ---------- 升级版异动交易 · 1m K 线仓库 ----------
// 滚动 24h 基线只用「已收盘」1m K 线——修复规格书点名的基准漂移，
// 绝不用含当前价快照的 24hr 统计覆盖旧基准（§四）。
// 请求预算：冷启动 2 req/标的（并发由引擎控制），稳态轮换 1 req/标的/5min。

import { bFetch } from '../binance';
import { STORE } from './config';

export interface Candle1m {
  t: number; // openTime ms
  o: number;
  h: number;
  l: number;
  c: number;
  qv: number; // quote volume
}

interface KlineRow extends Array<unknown> {
  length: number;
}

interface SymbolKlines {
  symbol: string;
  candles: Candle1m[];
  lastFetchAt: number;
  firstT: number;
  /** 中位数/趋势缓存（60s TTL，tick 高频读取不重算） */
  cache: {
    computedAt: number;
    med1m: number | null;
    med5m: number | null;
    coverage: number;
    r15m: number | null;
    r1h: number | null;
  };
  /** 24h 滚动高低点缓存（15s TTL） */
  rangeCache: {
    computedAt: number;
    high: number | null;
    low: number | null;
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pctAbs(a: number, b: number): number {
  return b !== 0 ? Math.abs(a / b - 1) * 100 : 0;
}

export class KlineStore {
  outbound = 0; // 本仓库出站请求计数（独立统计）
  private map = new Map<string, SymbolKlines>();

  has(symbol: string): boolean {
    return this.map.has(symbol);
  }

  get(symbol: string): SymbolKlines | undefined {
    return this.map.get(symbol);
  }

  remove(symbol: string): void {
    this.map.delete(symbol);
  }

  trackedSymbols(): string[] {
    return [...this.map.keys()];
  }

  trackedCount(): number {
    return this.map.size;
  }

  /** 已收盘 1m K 线（t + 60s ≤ now），闭区间 lookbackMs 窗口 */
  closedCandles(symbol: string, lookbackMs: number, now: number): Candle1m[] {
    const s = this.map.get(symbol);
    if (!s) return [];
    const from = now - lookbackMs;
    return s.candles.filter((c) => c.t >= from && c.t + 60_000 <= now);
  }

  /** 24h 滚动高低点（已收盘 K 线；15s TTL 缓存），样本不足返回 null */
  range24h(symbol: string, now: number): { high: number; low: number } | null {
    const s = this.map.get(symbol);
    if (!s) return null;
    if (s.rangeCache.computedAt > now - 15_000) {
      if (s.rangeCache.high != null && s.rangeCache.low != null) {
        return { high: s.rangeCache.high, low: s.rangeCache.low };
      }
      return null;
    }
    const window = this.closedCandles(symbol, 24 * 3_600_000, now);
    s.rangeCache.computedAt = now;
    if (window.length < 240) {
      s.rangeCache.high = null;
      s.rangeCache.low = null;
      return null;
    }
    let high = -Infinity;
    let low = Infinity;
    for (const c of window) {
      if (c.h > high) high = c.h;
      if (c.l < low) low = c.l;
    }
    s.rangeCache.high = high;
    s.rangeCache.low = low;
    return { high, low };
  }

  /** 过去 N 根已收盘 1m K 线成交额（放量中位数基准用） */
  recentClosedQv(symbol: string, count: number): number[] {
    const s = this.map.get(symbol);
    if (!s) return [];
    const out: number[] = [];
    for (let i = s.candles.length - 1; i >= 0 && out.length < count; i--) {
      const c = s.candles[i];
      if (c.t + 60_000 > this.lastNow(c)) continue;
      out.unshift(c.qv);
    }
    return out;
  }

  private lastNow(_c: Candle1m): number {
    return Date.now();
  }

  /** 6h 已收盘 1m 收益率绝对值中位数（%）；样本 < minSamples 返回 null（退回固定阈值） */
  medAbsReturn1m(symbol: string, now: number): number | null {
    return this.cached(symbol, now).med1m;
  }

  /** 12h 5m 收益率绝对值中位数（%） */
  medAbsReturn5m(symbol: string, now: number): number | null {
    return this.cached(symbol, now).med5m;
  }

  shortTrend(symbol: string, now: number): { r15m: number | null; r1h: number | null } {
    const c = this.cached(symbol, now);
    return { r15m: c.r15m, r1h: c.r1h };
  }

  coverage(s: SymbolKlines, now: number): number {
    return this.recomputeIfNeeded(s, now).coverage;
  }

  baselineReadyCount(now: number): number {
    let n = 0;
    for (const s of this.map.values()) {
      if (this.recomputeIfNeeded(s, now).med1m != null) n++;
    }
    return n;
  }

  // ============ 写入：回填与轮换 ============

  /** 冷启动回填：最近 ~26h，最多 2 req（1000 + 1000） */
  async backfill(symbol: string): Promise<void> {
    try {
      this.outbound++;
      const rows = await bFetch<KlineRow[]>('/api/v3/klines', { symbol, interval: '1m', limit: 1000 });
      let list = rows.map(mapRow);
      if (rows.length >= 1000) {
        this.outbound++;
        const firstOpen = rows[0][0] as number;
        const older = await bFetch<KlineRow[]>('/api/v3/klines', {
          symbol,
          interval: '1m',
          limit: 1000,
          endTime: firstOpen - 1,
        });
        list = [...older.map(mapRow), ...list];
      }
      if (list.length === 0) return;
      const now = Date.now();
      const s: SymbolKlines = {
        symbol,
        candles: this.prune(list, now),
        lastFetchAt: now,
        firstT: list[0].t,
        cache: { computedAt: 0, med1m: null, med5m: null, coverage: 0, r15m: null, r1h: null },
        rangeCache: { computedAt: 0, high: null, low: null },
      };
      this.map.set(symbol, s);
    } catch {
      // 单标的回填失败不阻断整体（覆盖度不足时自动退回固定阈值）
    }
  }

  /** 稳态轮换：增量拉取新 K 线（1 req/标的/5min），并淘汰窗口外旧数据 */
  async rotate(symbol: string, now: number): Promise<void> {
    const s = this.map.get(symbol);
    if (!s) return;
    try {
      const lastT = s.candles.length > 0 ? s.candles[s.candles.length - 1].t : now - 3_600_000;
      this.outbound++;
      const rows = await bFetch<KlineRow[]>('/api/v3/klines', {
        symbol,
        interval: '1m',
        limit: 120,
        startTime: lastT + 1,
      });
      if (rows.length > 0) {
        const fresh = rows.map(mapRow);
        const seen = new Set(s.candles.map((c) => c.t));
        for (const c of fresh) if (!seen.has(c.t)) s.candles.push(c);
      }
      s.candles = this.prune(s.candles, now);
      s.lastFetchAt = now;
      s.rangeCache.computedAt = 0; // 有新数据，范围缓存失效
    } catch {
      // 轮换失败等下个周期重试
    }
  }

  // ============ 内部 ============

  private prune(candles: Candle1m[], now: number): Candle1m[] {
    const from = now - STORE.keepHours * 3_600_000;
    const kept = candles.filter((c) => c.t >= from);
    return kept.length > 0 ? kept : candles.slice(-1000);
  }

  private cached(symbol: string, now: number) {
    const s = this.map.get(symbol);
    if (!s) return { med1m: null, med5m: null, coverage: 0, r15m: null, r1h: null };
    return this.recomputeIfNeeded(s, now);
  }

  private recomputeIfNeeded(s: SymbolKlines, now: number) {
    if (s.cache.computedAt > now - 60_000) return s.cache;
    // 1m 收益率（过去 6h，含窗口边界前一根作基数）
    const w1 = this.closedCandles(s.symbol, (STORE.keepHours - 20) * 3_600_000, now);
    const from1 = now - 6 * 3_600_000;
    const window1 = w1.filter((c) => c.t >= from1 - 60_000);
    const rets1: number[] = [];
    for (let i = 1; i < window1.length; i++) {
      if (window1[i].t >= from1) rets1.push(pctAbs(window1[i].c, window1[i - 1].c));
    }
    // 5m 收益率（过去 12h，按 5m 桶对齐收盘）
    const from5 = now - 12 * 3_600_000;
    const buckets = new Map<number, number>();
    for (const c of w1) {
      if (c.t + 60_000 <= now && c.t >= from5 - 300_000) {
        buckets.set(Math.floor(c.t / 300_000), c.c); // 桶内最后一根收盘价
      }
    }
    const bKeys = [...buckets.keys()].sort((a, b) => a - b);
    const rets5: number[] = [];
    for (let i = 1; i < bKeys.length; i++) {
      const prev = buckets.get(bKeys[i - 1])!;
      const cur = buckets.get(bKeys[i])!;
      if (bKeys[i] * 300_000 >= from5) rets5.push(pctAbs(cur, prev));
    }
    // 短线趋势：15m / 1h
    const last = w1.length > 0 ? w1[w1.length - 1] : null;
    const at15 = this.closeAtOrBefore(s.symbol, now - 15 * 60_000);
    const at60 = this.closeAtOrBefore(s.symbol, now - 60 * 60_000);
    s.cache = {
      computedAt: now,
      med1m: rets1.length >= 60 ? (median(rets1) ?? null) : null,
      med5m: rets5.length >= 60 ? (median(rets5) ?? null) : null,
      coverage: Math.min(1, w1.filter((c) => c.t >= from1).length / 360),
      r15m: last && at15 ? (last.c / at15.c - 1) * 100 : null, // 15m 前到现在
      r1h: last && at60 ? (last.c / at60.c - 1) * 100 : null,
    };
    return s.cache;
  }

  private closeAtOrBefore(symbol: string, time: number): Candle1m | null {
    const s = this.map.get(symbol);
    if (!s) return null;
    let found: Candle1m | null = null;
    for (const c of s.candles) {
      if (c.t + 60_000 <= time) found = c;
      else break;
    }
    return found;
  }
}

function mapRow(r: KlineRow): Candle1m {
  return {
    t: r[0] as number,
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    qv: Number(r[7]),
  };
}
