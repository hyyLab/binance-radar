// ---------- USDT-M 合约多源行情采集器（升级版异动交易数据源） ----------
// 架构（Task 50 用户定版）：多源发现异动 + 单源供价。
//  - 品种白名单 = 币安 U 本位永续（binance instruments：PERPETUAL+USDT+TRADING），
//    只做币安包含的品种；Bybit / Gate 仅作为同一批符号的行情冗余源；
//  - 供价优先级 币安 > Bybit > Gate：同一符号的短窗涨跌幅/量能只从「其所属源」的
//    自身价格史计算（绝不混源——拼源会造出假异动）；源连续失败自动挂起 60s 并降级
//    下一源，恢复后按优先级自动回到币安；
//  - 每 5s 全源拉最新价 → 维护各源价格滚动窗口（20 分钟 5s 精度 + 更早 1 分钟精度）；
//    每 30s 拉 24hr 统计 → 差分出每分钟成交额；启动回填 Top120 的 1m K 线，
//    让 chg1m/chg5m 即刻可用（与现货 collector 同款工艺）。
// ⚠️ Turbopack dev 下每个 API 路由可持有独立模块图：模块级单例必须「同 key 必复用」
//    （跨路由收敛到同一实例），代码更新靠 bump key（v1→v2…）；跨引擎引用一律走
//    稳定别名 __binanceRadarFuturesActive 动态解析活跃实例（Task 44 规则）。

import { isExcludedBase } from './excluded';
import {
  FUTURES_SOURCE_PRIORITY,
  SOURCE_LABEL,
  fetch24h,
  fetchInstruments,
  fetchKlines,
  fetchPrices,
  type FuturesCandle,
  type FuturesSourceName,
  type InstrumentsMap,
  type KlinesOpts,
  type Stats24Row,
} from './futures-feeds';
import type { FuturesSourceHealth, TickerSnapshot } from './types';

// ---------- 常量 ----------
const PRICE_INTERVAL_MS = 5_000;
const TF_INTERVAL_MS = 30_000;
const INSTRUMENT_REFRESH_MS = 60 * 60_000; // 合约清单每小时刷新
const MIN_QV_DISPLAY = 100_000; // 展示门槛：24h 成交额 ≥ 10 万 USDT
const TOP_BACKFILL = 120;
const SUSPEND_MS = 60_000; // 源连续失败挂起时长
const RATE_LIMIT_SUSPEND_MS = 180_000; // 418/429 限频封禁挂起时长（封禁期内不撞墙，行情自动降级下一源）
const FAIL_STREAK_LIMIT = 4; // 连续失败次数阈值（≈20s 全失败即挂起）
const PRICE_FRESH_MS = 15_000; // 供价源数据新鲜度要求

// ---------- 内部结构 ----------
interface PricePoint {
  t: number;
  p: number;
}

interface VolSample {
  t: number; // 分钟桶
  qv: number; // 每分钟成交额（USDT，差分归一化）
}

interface SourceState {
  instruments: InstrumentsMap;
  instrumentsAt: number;
  lastPriceAt: number;
  last24hAt: number;
  failStreak: number;
  suspendUntil: number;
  lastError: string;
  priceHist: Map<string, PricePoint[]>;
  stats24: Map<string, Stats24Row>;
  lastVolSnap: Map<string, { at: number; qv24: number }>;
  volSamples: Map<string, VolSample[]>;
}

/** 聚合后的行情行（= TickerSnapshot + 来源标记） */
type MergedRow = TickerSnapshot & { source: FuturesSourceName };

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 找到时间 ≥ target 的最早采样点，计算相对当前价的涨跌 % */
function chgSince(hist: PricePoint[], target: number, price: number): number | null {
  if (!hist || hist.length === 0 || price <= 0) return null;
  for (const pt of hist) {
    if (pt.t >= target && pt.p > 0) return ((price - pt.p) / pt.p) * 100;
  }
  const lastPt = hist[hist.length - 1];
  return lastPt.p > 0 ? ((price - lastPt.p) / lastPt.p) * 100 : null;
}

export class FuturesCollector {
  private sources: Record<FuturesSourceName, SourceState> = {
    binance: FuturesCollector.freshSource(),
    bybit: FuturesCollector.freshSource(),
    gate: FuturesCollector.freshSource(),
  };
  private merged = new Map<string, MergedRow>();
  private started = false;
  private starting: Promise<void> | null = null;
  priceTimer: ReturnType<typeof setInterval> | null = null;
  tfTimer: ReturnType<typeof setInterval> | null = null;
  meta = { startedAt: 0 };

  private static freshSource(): SourceState {
    return {
      instruments: new Map(),
      instrumentsAt: 0,
      lastPriceAt: 0,
      last24hAt: 0,
      failStreak: 0,
      suspendUntil: 0,
      lastError: '',
      priceHist: new Map(),
      stats24: new Map(),
      lastVolSnap: new Map(),
      volSamples: new Map(),
    };
  }

  /** 启动采集（幂等）。返回最多等待 6s 的就绪 Promise，超时不阻塞响应。 */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, sleep(6000)]);
      return;
    }
    this.started = true;
    this.meta.startedAt = Date.now();
    this.starting = this.boot();
    await Promise.race([this.starting, sleep(6000)]);
  }

  private async boot(): Promise<void> {
    // 1) 首拉合约清单（币安白名单就绪才能过滤行情）
    await Promise.allSettled(FUTURES_SOURCE_PRIORITY.map((s) => this.refreshInstruments(s)));
    // 2) 首拉价格 + 24h（第一批数据就绪后 merged 才非空）
    await Promise.allSettled([this.pollAllPrices(), this.pollAllStats()]);
    // 3) 定时器：5s 价格 / 30s 24h 统计（清单刷新由 refreshInstruments 自链式调度）
    this.priceTimer = setInterval(() => void this.pollAllPrices(), PRICE_INTERVAL_MS);
    this.tfTimer = setInterval(() => void this.pollAllStats(), TF_INTERVAL_MS);
    // 4) 启动回填 Top120（chg1m/chg5m 即刻可用）
    void this.backfillTop();
  }

  // ============ 合约清单（每小时自刷新，失败 60s 重试） ============

  private async refreshInstruments(source: FuturesSourceName): Promise<void> {
    const st = this.sources[source];
    try {
      st.instruments = await fetchInstruments(source);
      st.instrumentsAt = Date.now();
      st.failStreak = 0;
      st.suspendUntil = 0;
      st.lastError = '';
      setTimeout(() => void this.refreshInstruments(source), INSTRUMENT_REFRESH_MS);
    } catch (e) {
      st.lastError = errMsg(e);
      setTimeout(() => void this.refreshInstruments(source), 60_000);
    }
  }

  // ============ 价格轮询（每 5s 全源并行） ============

  private async pollAllPrices(): Promise<void> {
    const now = Date.now();
    await Promise.allSettled(
      FUTURES_SOURCE_PRIORITY.map(async (s) => {
        const st = this.sources[s];
        if (now < st.suspendUntil || st.instruments.size === 0) return;
        try {
          const rows = await fetchPrices(s, st.instruments);
          this.ingestPrices(s, rows);
          st.failStreak = 0;
          st.suspendUntil = 0;
          st.lastError = '';
        } catch (e) {
          this.noteFailure(s, e);
        }
      }),
    );
    this.rebuildMerged();
  }

  private ingestPrices(source: FuturesSourceName, rows: { symbol: string; price: number }[]) {
    const st = this.sources[source];
    const now = Date.now();
    for (const r of rows) {
      let hist = st.priceHist.get(r.symbol);
      if (!hist) {
        hist = [];
        st.priceHist.set(r.symbol, hist);
      }
      hist.push({ t: now, p: r.price });
      this.trimHist(hist, now);
    }
    st.lastPriceAt = now;
  }

  /** 压缩历史：20 分钟内保留 5s 精度，更早的压缩为 1 分钟精度，总量 ≤ 75 分钟 */
  private trimHist(hist: PricePoint[], now: number) {
    const maxAge = now - 75 * 60_000;
    let drop = 0;
    while (drop < hist.length && hist[drop].t < maxAge) drop++;
    if (drop > 0) hist.splice(0, drop);
    const cutoff = now - 20 * 60_000;
    let bound = 0;
    while (bound < hist.length && hist[bound].t < cutoff) bound++;
    if (bound <= 1) return;
    const compacted: PricePoint[] = [];
    let lastMinute = -1;
    for (let i = 0; i < bound; i++) {
      const m = Math.floor(hist[i].t / 60_000);
      if (m !== lastMinute) {
        compacted.push(hist[i]);
        lastMinute = m;
      }
    }
    if (compacted.length < bound) {
      hist.splice(0, bound, ...compacted);
    }
  }

  // ============ 24hr 统计（每 30s 全源并行，差分 vol1m） ============

  private async pollAllStats(): Promise<void> {
    const now = Date.now();
    await Promise.allSettled(
      FUTURES_SOURCE_PRIORITY.map(async (s) => {
        const st = this.sources[s];
        if (now < st.suspendUntil || st.instruments.size === 0) return;
        try {
          const rows = await fetch24h(s, st.instruments);
          this.ingestStats(s, rows, Date.now());
          st.failStreak = 0;
          st.suspendUntil = 0;
          st.lastError = '';
        } catch (e) {
          this.noteFailure(s, e);
        }
      }),
    );
    this.rebuildMerged();
  }

  private ingestStats(source: FuturesSourceName, rows: Stats24Row[], now: number) {
    const st = this.sources[source];
    for (const row of rows) {
      // 差分出每分钟成交额（窗口下限仅防零间隔抖动，同现货 collector 参数）
      const prev = st.lastVolSnap.get(row.symbol);
      if (prev) {
        const dtMin = (now - prev.at) / 60_000;
        if (dtMin >= 0.35 && dtMin <= 6) {
          const perMin = (row.qv24 - prev.qv24) / dtMin;
          if (Number.isFinite(perMin) && perMin >= 0) {
            const bucket = Math.floor(now / 60_000) * 60_000;
            let vs = st.volSamples.get(row.symbol);
            if (!vs) {
              vs = [];
              st.volSamples.set(row.symbol, vs);
            }
            const lastS = vs[vs.length - 1];
            if (lastS && lastS.t === bucket) lastS.qv = perMin;
            else {
              vs.push({ t: bucket, qv: perMin });
              if (vs.length > 30) vs.splice(0, vs.length - 30);
            }
          }
        }
      }
      st.lastVolSnap.set(row.symbol, { at: now, qv24: row.qv24 });
      st.stats24.set(row.symbol, row);
    }
    st.last24hAt = now;
  }

  private noteFailure(source: FuturesSourceName, e: unknown) {
    const st = this.sources[source];
    const msg = errMsg(e);
    st.lastError = msg;
    // 418/429 = 币安限频/封禁：直接长挂起，避免封禁期内反复撞墙延长封禁
    if (msg.includes('HTTP 418') || msg.includes('HTTP 429')) {
      st.suspendUntil = Date.now() + RATE_LIMIT_SUSPEND_MS;
      st.failStreak = 0;
      return;
    }
    st.failStreak++;
    if (st.failStreak >= FAIL_STREAK_LIMIT) {
      st.suspendUntil = Date.now() + SUSPEND_MS;
      st.failStreak = 0;
    }
  }

  // ============ 聚合：按优先级选源（单源供价不变式） ============

  /** 为符号选择供价源：优先级顺序内第一个「未挂起 + 价格史新鲜」的源 */
  private selectSource(symbol: string, now: number): FuturesSourceName | null {
    for (const s of FUTURES_SOURCE_PRIORITY) {
      const st = this.sources[s];
      if (now < st.suspendUntil) continue;
      if (now - st.lastPriceAt > PRICE_FRESH_MS) continue;
      const hist = st.priceHist.get(symbol);
      if (!hist || hist.length === 0) continue;
      const last = hist[hist.length - 1];
      if (now - last.t > PRICE_FRESH_MS || !(last.p > 0)) continue;
      return s;
    }
    return null;
  }

  /** 重建聚合行情：白名单 = 币安 U 本位永续（只做币安包含的品种） */
  private rebuildMerged(): void {
    const now = Date.now();
    const whitelist = this.sources.binance.instruments;
    for (const [symbol, ins] of whitelist) {
      if (isExcludedBase(ins.base)) {
        this.merged.delete(symbol); // 稳定币对 / 代币化股票等（USDC 永续等）
        continue;
      }
      const sel = this.selectSource(symbol, now);
      if (!sel) {
        this.merged.delete(symbol); // 全源无新鲜数据 → 移出（恢复后自动回来）
        continue;
      }
      const st = this.sources[sel];
      const hist = st.priceHist.get(symbol)!;
      const lastPt = hist[hist.length - 1];
      const price = lastPt.p;
      const prevPt = hist.length >= 2 ? hist[hist.length - 2] : null;
      const s24 = st.stats24.get(symbol);
      const vs = st.volSamples.get(symbol) ?? [];
      let vol1m = 0;
      let volAvg20m = 0;
      if (vs.length >= 5) {
        const window = vs.slice(-21, -1); // 过去 20 个完整分钟
        volAvg20m = window.reduce((acc, x) => acc + x.qv, 0) / window.length;
        vol1m = vs[vs.length - 1].qv;
      }
      const prevRow = this.merged.get(symbol);
      const tickDir: 1 | -1 | 0 =
        prevPt && price !== prevPt.p ? (price > prevPt.p ? 1 : -1) : (prevRow?.tickDir ?? 0);
      const row: MergedRow = {
        symbol,
        base: ins.base,
        price,
        open: s24?.open24 || price,
        high24h: s24?.high24 || price,
        low24h: s24?.low24 || price,
        change24h: s24?.chg24 ?? 0,
        quoteVolume24h: s24?.qv24 ?? 0,
        chg1m: chgSince(hist, now - 60_000, price),
        chg5m: chgSince(hist, now - 5 * 60_000, price),
        chg15m: chgSince(hist, now - 15 * 60_000, price),
        chg1h: chgSince(hist, now - 60 * 60_000, price),
        vol1m: vol1m > 0 ? vol1m : null,
        volMultiple: volAvg20m > 0 && vol1m > 0 ? vol1m / volAvg20m : null,
        tickDir,
        hotTags: null,
        updatedAt: st.lastPriceAt || now,
        source: sel,
      };
      this.merged.set(symbol, row);
    }
  }

  // ============ 对外查询 ============

  getTickers(): TickerSnapshot[] {
    const out: TickerSnapshot[] = [];
    for (const row of this.merged.values()) {
      if (row.quoteVolume24h < MIN_QV_DISPLAY) continue;
      out.push({ ...row });
    }
    return out;
  }

  hasSymbol(symbol: string): boolean {
    return this.merged.has(symbol);
  }

  /** 该符号当前供价源（K 线同源取数优先用它，保证价/图一致） */
  sourceOf(symbol: string): FuturesSourceName | null {
    return this.merged.get(symbol)?.source ?? null;
  }

  /** tickSize（按优先级取第一个有清单的源） */
  tickSizeOf(symbol: string): number {
    for (const s of FUTURES_SOURCE_PRIORITY) {
      const ins = this.sources[s].instruments.get(symbol);
      if (ins && ins.tickSize > 0) return ins.tickSize;
    }
    return 0;
  }

  getSourcesHealth(): FuturesSourceHealth[] {
    const now = Date.now();
    return FUTURES_SOURCE_PRIORITY.map((source) => {
      const st = this.sources[source];
      let symbols = 0;
      for (const row of this.merged.values()) if (row.source === source) symbols++;
      return {
        source,
        label: SOURCE_LABEL[source],
        ok: now - st.lastPriceAt < PRICE_FRESH_MS && st.instruments.size > 0,
        suspended: now < st.suspendUntil,
        lastPriceOkAt: st.lastPriceAt,
        last24hOkAt: st.last24hAt,
        symbols,
        lastError: st.lastError,
      };
    });
  }

  // ============ K 线（异动引擎基线 + 图表共用；按符号同源取数） ============

  /** K 线取数顺序：当前供价源优先，随后按优先级补位（仅限有该符号清单的源）。
   *  挂起中的源直接跳过——币安 418 封禁期间 K 线自动改走 Bybit/Gate，不在墙上硬撞 */
  private klineSourceOrder(symbol: string): FuturesSourceName[] {
    const now = Date.now();
    const order: FuturesSourceName[] = [];
    const sel = this.sourceOf(symbol);
    if (sel && now >= this.sources[sel].suspendUntil) order.push(sel);
    for (const s of FUTURES_SOURCE_PRIORITY) {
      if (order.includes(s)) continue;
      if (now < this.sources[s].suspendUntil) continue;
      if (!this.sources[s].instruments.has(symbol)) continue;
      order.push(s);
    }
    return order;
  }

  /** 取 K 线并告知实际来源（回填播种需要同源写入价格史，保持「单源供价」不变式） */
  async fetchKlinesFrom(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
    opts: KlinesOpts,
  ): Promise<{ source: FuturesSourceName; candles: FuturesCandle[] }> {
    for (const s of this.klineSourceOrder(symbol)) {
      const ins = this.sources[s].instruments.get(symbol);
      if (!ins) continue;
      try {
        const candles = await fetchKlines(s, ins.native, interval, opts);
        if (candles.length > 0) return { source: s, candles };
      } catch {
        // 换下一源
      }
    }
    throw new Error(`合约 K 线不可用：${symbol}`);
  }

  async fetchKlinesFor(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
    opts: KlinesOpts,
  ): Promise<FuturesCandle[]> {
    return (await this.fetchKlinesFrom(symbol, interval, opts)).candles;
  }

  // ============ 启动回填：Top120 的 1m K 线 → chg1m/chg5m 即刻可用 ============

  private async backfillTop(): Promise<void> {
    try {
      for (let i = 0; i < 30 && this.merged.size === 0; i++) await sleep(1000);
      if (this.merged.size === 0) return;
      const top = [...this.merged.values()]
        .filter((r) => r.quoteVolume24h >= 1_000_000)
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
        .slice(0, TOP_BACKFILL);
      const now = Date.now();
      let cursor = 0;
      const worker = async () => {
        while (cursor < top.length) {
          const row = top[cursor++];
          try {
            const res = await this.fetchKlinesFrom(row.symbol, '1m', { limit: 75 });
            this.seedHistory(row, res.source, res.candles, now);
          } catch {
            // 单币种失败忽略
          }
          await sleep(300); // 温和节流：与引擎回填错峰，防币安 fapi 418 限频
        }
      };
      await Promise.all(Array.from({ length: 2 }, worker)); // 并发 2（Task 50 节流）
    } catch {
      // 回填失败不影响后续实时采集
    }
  }

  /** 播种价格史/量能基线——只写「实际供 K 线的那个源」，避免跨源拼接 */
  private seedHistory(
    row: MergedRow,
    source: FuturesSourceName,
    candles: FuturesCandle[],
    now: number,
  ) {
    if (source !== row.source) return; // 供价源 K 线失败且降级 → 不播种（等实时累积）
    const st = this.sources[source];
    const hist: PricePoint[] = candles
      .filter((c) => Number.isFinite(c.c) && c.c > 0)
      .map((c) => ({ t: c.t, p: c.c }));
    if (hist.length > 0) {
      hist.push({ t: now, p: row.price });
      st.priceHist.set(row.symbol, hist);
    }
    const vs: { t: number; qv: number }[] = [];
    for (const c of candles) {
      if (c.t >= now - 21 * 60_000 && c.t + 60_000 <= now && Number.isFinite(c.qv)) {
        vs.push({ t: c.t, qv: c.qv });
      }
    }
    if (vs.length >= 4) st.volSamples.set(row.symbol, vs);
  }
}

// ---------- 全局单例（HMR 安全，同 Task 44/collector 规则） ----------
const g = globalThis as typeof globalThis & {
  __binanceRadarFutures_v1?: FuturesCollector;
  __binanceRadarFuturesActive?: FuturesCollector;
};

function clearFuturesTimers(c: unknown): void {
  const legacy = c as {
    priceTimer?: ReturnType<typeof setInterval> | null;
    tfTimer?: ReturnType<typeof setInterval> | null;
  } | null;
  if (!legacy) return;
  if (legacy.priceTimer) clearInterval(legacy.priceTimer);
  if (legacy.tfTimer) clearInterval(legacy.tfTimer);
  legacy.priceTimer = null;
  legacy.tfTimer = null;
}

export const futuresCollector: FuturesCollector = (() => {
  const existing = g.__binanceRadarFutures_v1;
  if (existing) {
    g.__binanceRadarFuturesActive = existing; // 每次图评估都刷新稳定别名
    return existing;
  }
  const fresh = new FuturesCollector();
  g.__binanceRadarFutures_v1 = fresh;
  g.__binanceRadarFuturesActive = fresh;
  return fresh;
})();

/** 跨引擎动态解析活跃实例（paper / enhanced 引用一律走这里，Task 44 规则） */
export function activeFuturesCollector(): FuturesCollector {
  return g.__binanceRadarFuturesActive ?? futuresCollector;
}

export { clearFuturesTimers };
