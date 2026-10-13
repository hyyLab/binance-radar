// ---------- 升级版异动交易 · 引擎单例 ----------
// 编排：行情有效性检查（§2.2）→ 三检测器（独立）→ 事件聚合器（§七）。
// 数据源：collector 的 2s 全市场内存快照（零额外请求）+ 本引擎的 1m K 线仓库
//（滚动 24h 基线 / 自适应阈值 / 放量中位数基准，稳态 ~10 req/min）。
// 单例驻留 globalThis，HMR 不重复启动；只在 /api/enhanced/* 被访问时启动。

import { bFetch } from '../binance';
import { collector } from '../collector';
import { isExcludedBase } from '../excluded';
import { AGG, STORE, VALIDITY, VOLUME, tierOf } from './config';
import { KlineStore } from './klines';
import { BreakoutTracker, detectSpike, detectVolume, type TickSnap } from './detectors';
import { Aggregator, type FeedCtx } from './aggregate';
import type {
  Detection,
  DetectionLogEntry,
  EnhancedEventDTO,
  EnhancedStats,
  SymStats,
} from './types';

const TICK_MS = 2_000;
const VOLUME_MS = 30_000;
const ROTATE_SLOT_MS = 12_000;
const WATCHLIST_MS = 5 * 60_000;
const SWEEP_MS = 30_000;

interface SuspectState {
  ticks: number;
  firstPrice: number;
  dir: 'UP' | 'DOWN';
  logged: boolean;
}

interface ExchangeInfoEntry {
  status: string;
  baseAsset: string;
  tickSize: number;
}

export class EnhancedEngine {
  store: KlineStore;
  private breakout = new BreakoutTracker();
  private agg = new Aggregator();
  private logs: DetectionLogEntry[] = [];

  private started = false;
  private starting: Promise<void> | null = null;
  private startedAt = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private bootBackfillAborted = false;

  /** 可接管旧实例的 K 线仓库（热重置时避免重复回填出站请求） */
  constructor(carriedStore?: KlineStore) {
    this.store = carriedStore ?? new KlineStore();
  }

  /** 停止本实例全部定时器与回填（热重置用，防双实例重复出站） */
  stop(): void {
    this.bootBackfillAborted = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
  }

  private tickSizeMap = new Map<string, ExchangeInfoEntry>();
  private suspects = new Map<string, SuspectState>();
  private baselineNoteAt = new Map<string, number>(); // BASELINE_INSUFFICIENT 节流
  private expansionQueue: string[] = [];
  private rotateCursor = 0;
  private dataAnomalies = 0;
  private lastRotateAt = 0;
  private backfillDone = 0;
  private backfillTotal = 0;

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, new Promise((r) => setTimeout(r, 8000))]);
      return;
    }
    this.started = true;
    this.startedAt = Date.now();
    this.starting = this.boot();
    await Promise.race([this.starting, new Promise((r) => setTimeout(r, 8000))]);
  }

  private async boot(): Promise<void> {
    // 1) 交易对校验（§2.1）：状态 + 精度，每小时刷新
    void this.refreshExchangeInfo();
    // 2) 等 collector 就绪（tickers 有数据），再建监控清单
    setTimeout(() => void this.buildWatchlistAndBackfill(), STORE.collectReadyWaitMs);
    // 3) 定时器：2s 检测 / 30s 放量 / 12s 轮换槽 / 5min 清单 / 30s 结束判定
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.volumeTick(), VOLUME_MS));
    this.timers.push(setInterval(() => void this.rotateSlot(), ROTATE_SLOT_MS));
    this.timers.push(setInterval(() => this.rebuildWatchlist(), WATCHLIST_MS));
    this.timers.push(setInterval(() => this.agg.sweep(Date.now()), SWEEP_MS));
  }

  private async refreshExchangeInfo(): Promise<void> {
    try {
      const info = await bFetch<{
        symbols: {
          symbol: string;
          status: string;
          baseAsset: string;
          filters: { filterType: string; tickSize?: string }[];
        }[];
      }>('/api/v3/exchangeInfo', { permissions: 'SPOT' });
      this.tickSizeMap.clear();
      for (const s of info.symbols) {
        const pf = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
        this.tickSizeMap.set(s.symbol, {
          status: s.status,
          baseAsset: s.baseAsset,
          tickSize: pf?.tickSize ? Number(pf.tickSize) : 0,
        });
      }
    } catch {
      // 校验信息不可用时降级：tickSize 按价格估算，状态视为通过（检测仍有其余有效性检查）
    }
    setTimeout(() => void this.refreshExchangeInfo(), STORE.exchangeInfoRefreshMs);
  }

  // ============ 监控清单（§2.1/§六） ============

  private candidateUniverse(): { symbol: string; qv: number }[] {
    const out: { symbol: string; qv: number }[] = [];
    for (const t of collector.getTickers()) {
      if (isExcludedBase(t.base)) continue; // 代币化股票/贵金属
      const info = this.tickSizeMap.get(t.symbol);
      if (info && info.status !== 'TRADING') continue; // 未通过交易对校验
      if (t.price <= 0) continue;
      out.push({ symbol: t.symbol, qv: t.quoteVolume24h });
    }
    return out.sort((a, b) => b.qv - a.qv);
  }

  private async buildWatchlistAndBackfill(): Promise<void> {
    if (collector.getTickers().length === 0) {
      // collector 未就绪，稍后重试
      setTimeout(() => void this.buildWatchlistAndBackfill(), 10_000);
      return;
    }
    this.rebuildWatchlist();
    if (this.baselineNoteAt.size > 800) this.baselineNoteAt.clear(); // 节流表防膨胀
    // 冷启动回填：按成交额降序，前 bootBackfillCap 个立即回填（并发 2 + 间隔，防突发）
    const list = this.candidateUniverse()
      .filter((c) => c.qv >= 5_000_000 && !this.store.has(c.symbol))
      .slice(0, STORE.bootBackfillCap);
    this.backfillTotal = list.length;
    this.backfillDone = 0;
    void this.runBootBackfill(list);
  }

  private async runBootBackfill(
    list: { symbol: string; qv: number }[],
  ): Promise<void> {
    const CONC = STORE.bootConcurrency;
    let i = 0;
    while (i < list.length && !this.bootBackfillAborted) {
      const batch = list.slice(i, i + CONC);
      await Promise.all(batch.map((b) => this.store.backfill(b.symbol)));
      this.backfillDone += batch.length;
      i += CONC;
      await new Promise((r) => setTimeout(r, STORE.bootGapMs));
    }
  }

  /** 每 5 分钟重建清单：分层 + 扩充队列 + 淘汰（带迟滞） */
  private rebuildWatchlist(): void {
    const uni = this.candidateUniverse();
    const keep = uni.filter((c) => c.qv >= 1_000_000).slice(0, STORE.maxTracked);
    const keepSet = new Set(keep.map((c) => c.symbol));
    // 淘汰跌破 90 万（迟滞防抖）的标的
    for (const sym of this.store.trackedSymbols()) {
      if (!keepSet.has(sym)) {
        const qv = uni.find((c) => c.symbol === sym)?.qv ?? 0;
        if (qv < 900_000) this.store.remove(sym);
      }
    }
    // 扩充队列：清单内但未回填
    this.expansionQueue = keep
      .filter((c) => !this.store.has(c.symbol))
      .map((c) => c.symbol);
  }

  // ============ 轮换与扩充 ============

  private async rotateSlot(): Promise<void> {
    const syms = this.store.trackedSymbols();
    if (syms.length === 0) return;
    const now = Date.now();
    // 槽位轮换：每槽 rotatePerTick 个，保证单标的每 ~5 分钟刷新一次
    const slot: string[] = [];
    for (let n = 0; n < STORE.rotatePerTick; n++) {
      slot.push(syms[this.rotateCursor % syms.length]);
      this.rotateCursor++;
    }
    // 扩充：每槽最多 1 个新标的回填（≈5 req/min 的补充速率）
    const expand = this.expansionQueue.shift();
    if (expand && this.store.trackedCount() < STORE.maxTracked) {
      void this.store.backfill(expand);
    }
    await Promise.all(slot.map((s) => this.store.rotate(s, now)));
    this.lastRotateAt = Date.now();
    // 突破确认 B：收盘价检查（轮换后最后一根已收盘 K 线）
    for (const s of slot) {
      const snap = this.snapOf(s, now);
      if (!snap) continue;
      const d = this.breakout.onCloseCheck(s, now, this.store);
      if (d) this.feedDetection(d, snap, now);
    }
  }

  // ============ 2s 检测主循环 ============

  private tick(): void {
    const now = Date.now();
    const snaps = this.validSnaps(now);
    for (const snap of snaps) {
      // §2.2 疑似异常价格 → 复核状态，期间不产生有效异动
      if (this.inSuspectReview(snap, now)) continue;

      const stats = this.statsOf(snap, now);
      // SPIKE（每 2s）
      const spike = detectSpike(snap, stats);
      if (spike) this.feedDetection(spike, snap, now);
      // BREAKOUT（每 2s，状态机内部去重）
      const bo = this.breakout.onTick(snap, stats, this.store, now);
      if (bo) {
        if (bo.detail.includes('假')) this.feedFalseBreakout(bo, snap, now);
        else this.feedDetection(bo, snap, now);
      }
    }
  }

  private volumeTick(): void {
    const now = Date.now();
    for (const snap of this.validSnaps(now)) {
      if (this.suspects.has(snap.symbol)) continue;
      // 门槛外的币无需关注基线状态（过了双门槛才可能产出放量检测）
      if (snap.quoteVolume24h < VOLUME.minQv24h || (snap.vol1m ?? 0) < VOLUME.minQv1m) continue;
      const { detection, baseline } = detectVolume(snap, this.store, now);
      if (detection) {
        this.feedDetection(detection, snap, now);
        continue;
      }
      // §五：历史K线不足时标记 BASELINE_INSUFFICIENT（节流：每标的 10 分钟一条，防刷屏）
      if (baseline) {
        const last = this.baselineNoteAt.get(snap.symbol) ?? 0;
        if (now - last >= 600_000) {
          this.baselineNoteAt.set(snap.symbol, now);
          const why =
            baseline === 'NO_STORE'
              ? '未纳入K线跟踪（成交额排名/请求预算限制），放量检测不可用'
              : baseline === 'SHORT'
                ? '历史K线不足 20 根，放量基准未就绪'
                : '成交额基线接近零，不输出放量倍数';
          this.log(snap, now, 'BASELINE_INSUFFICIENT', why);
        }
      }
    }
  }

  // ============ 行情有效性（§2.2） ============

  private validSnaps(now: number): TickSnap[] {
    const out: TickSnap[] = [];
    for (const t of collector.getTickers()) {
      if (isExcludedBase(t.base)) continue;
      const info = this.tickSizeMap.get(t.symbol);
      if (info && info.status !== 'TRADING') continue;
      if (!(t.price > 0)) continue;
      // 时间戳有效性：collector 2s 节奏下超过 10s 视为延迟
      if (now - t.updatedAt > VALIDITY.maxTickAgeMs) continue;
      out.push({
        symbol: t.symbol,
        base: t.base,
        price: t.price,
        chg1m: t.chg1m,
        chg5m: t.chg5m,
        vol1m: t.vol1m ?? 0,
        quoteVolume24h: t.quoteVolume24h,
        change24h: t.change24h,
        updatedAt: t.updatedAt,
      });
    }
    return out;
  }

  /** 疑似跳价复核：极端涨跌幅先进入待确认；连续有效报价 + 成交额支持才放行 */
  private inSuspectReview(snap: TickSnap, now: number): boolean {
    const c1 = Math.abs(snap.chg1m ?? 0);
    const c5 = Math.abs(snap.chg5m ?? 0);
    const suspect = c1 >= VALIDITY.suspectChg1m || c5 >= VALIDITY.suspectChg5m;
    const st = this.suspects.get(snap.symbol);

    if (!st && !suspect) return false;
    if (!st && suspect) {
      this.suspects.set(snap.symbol, {
        ticks: 1,
        firstPrice: snap.price,
        dir: (snap.chg1m ?? 0) >= 0 ? 'UP' : 'DOWN',
        logged: false,
      });
      this.log(snap, now, 'REVIEW', '极端涨跌幅进入待确认复核，暂不产生有效异动');
      return true;
    }
    // 已在复核中
    if (st) {
      st.ticks++;
      const stillExtreme = suspect;
      const volOk = snap.vol1m >= VALIDITY.reviewMinQv1m;
      if (stillExtreme && volOk && st.ticks >= VALIDITY.reviewTicks) {
        // 复核通过：真实极端行情，放行（本次 tick 允许检测）
        this.suspects.delete(snap.symbol);
        this.log(snap, now, 'REVIEW_PASS', `复核通过：极端行情持续 ${st.ticks} tick 且成交额支持，恢复检测`);
        return false;
      }
      if (!stillExtreme && st.ticks < VALIDITY.reviewTicks) {
        // 快速消失且未通过连续性 → 判为数据异常，不产生事件
        this.suspects.delete(snap.symbol);
        this.dataAnomalies++;
        this.log(snap, now, 'DATA_ANOMALY', '极端跳价未通过复核（未持续/无成交额支持），按数据异常处理，不生成异动');
        return true;
      }
      if (st.ticks > 30) {
        // 长时间无法确认
        this.suspects.delete(snap.symbol);
        this.dataAnomalies++;
        this.log(snap, now, 'DATA_ANOMALY', '复核超时，按数据异常处理');
        return true;
      }
      return true;
    }
    return false;
  }

  // ============ 检测结果喂给聚合器 ============

  private feedDetection(d: Detection, snap: TickSnap, now: number): void {
    const ctx: FeedCtx = {
      snap,
      now,
      shortTrend: this.store.shortTrend(snap.symbol, now),
      tier: tierOf(snap.quoteVolume24h),
    };
    const res = this.agg.feed(d, ctx);
    this.log(
      snap,
      now,
      res.action,
      `${d.detector} ${d.dir} ${d.level} | ${d.detail} | ${res.notify ? '提醒' : '仅记录'}`,
      d,
    );
  }

  private feedFalseBreakout(d: Detection, snap: TickSnap, now: number): void {
    const ctx: FeedCtx = {
      snap,
      now,
      shortTrend: this.store.shortTrend(snap.symbol, now),
      tier: tierOf(snap.quoteVolume24h),
    };
    const res = this.agg.markFalseBreakout(d, ctx);
    this.log(snap, now, res.action, `${d.detail}`, d);
  }

  // ============ 统计 ============

  private statsOf(snap: TickSnap, _now: number): SymStats | undefined {
    // §三：自适应基准仅对已纳入K线跟踪的标的可用；不在仓库的币 medAbs=null →
    // detectSpike 自动退回固定阈值检测（绝不因缺K线而漏检 SPIKE，Task 45 修复：
    // 此前直接 undefined 导致 265 个达标币只有 220 个被检测）
    const tracked = this.store.has(snap.symbol);
    const s = tracked ? this.store.get(snap.symbol)! : null;
    const info = this.tickSizeMap.get(snap.symbol);
    return {
      symbol: snap.symbol,
      tier: tierOf(snap.quoteVolume24h),
      quoteVolume24h: snap.quoteVolume24h,
      medAbs1m: s ? this.store.medAbsReturn1m(snap.symbol, _now) : null,
      medAbs5m: s ? this.store.medAbsReturn5m(snap.symbol, _now) : null,
      medQv1m: null,
      dataCoverage: s ? this.store.coverage(s, _now) : 0,
      tickSize: info?.tickSize || snap.price * 0.0001,
      tradingOk: info ? info.status === 'TRADING' : true,
    };
  }

  private snapOf(symbol: string, now: number): TickSnap | null {
    for (const s of this.validSnaps(now)) if (s.symbol === symbol) return s;
    return null;
  }

  private log(
    snap: TickSnap,
    now: number,
    decision: string,
    reason: string,
    d?: Detection,
  ): void {
    const entry: DetectionLogEntry = {
      t: now,
      symbol: snap.symbol,
      price: snap.price,
      chg1m: snap.chg1m,
      chg5m: snap.chg5m,
      qv1m: snap.vol1m,
      qv24h: snap.quoteVolume24h,
      fixedThreshold: d ? spikeFixedLabel(d) : '—',
      adaptiveThreshold: d?.adaptiveUsed ? '自适应生效' : '固定阈值',
      decision,
      reason,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 2000) this.logs.length = 2000;
  }

  // ============ 对外查询 ============

  events(now: number): { active: EnhancedEventDTO[]; ended: EnhancedEventDTO[] } {
    return this.agg.list(now);
  }

  recentLogs(limit: number): DetectionLogEntry[] {
    return this.logs.slice(0, Math.min(limit, 500));
  }

  stats(): EnhancedStats {
    const now = Date.now();
    const counts = this.agg.counts();
    const tierCounts = { HIGH: 0, MID: 0, LOW: 0 };
    for (const t of collector.getTickers()) {
      const tier = tierOf(t.quoteVolume24h);
      if (tier !== 'NONE' && !isExcludedBase(t.base)) tierCounts[tier]++;
    }
    return {
      ts: now,
      startedAt: this.startedAt,
      engineOn: this.started,
      tracked: this.store.trackedCount(),
      tierCounts,
      bootBackfillDone: this.backfillDone,
      bootBackfillTotal: this.backfillTotal,
      expansionPending: this.expansionQueue.length,
      baselineReady: this.store.baselineReadyCount(now),
      activeEvents: counts.active,
      endedEvents: counts.ended,
      outboundRequests: this.store.outbound,
      lastRotateAt: this.lastRotateAt,
      dataAnomalies: this.dataAnomalies,
    };
  }
}

function spikeFixedLabel(d: Detection): string {
  if (d.detector === 'SPIKE') return d.windows?.join('+') ?? '1m';
  if (d.detector === 'BREAKOUT') return `24h±${d.magnitude.toFixed(2)}%`;
  return `vol×${d.magnitude.toFixed(1)}`;
}

// ============ 单例（globalThis 驻留，HMR 不重复启动） ============

const g = globalThis as typeof globalThis & { __binanceRadarEnhanced?: EnhancedEngine };

/** 每次读取都取 globalThis 上的当前实例（支持 ?reset=1 热替换，路由不依赖模块级常量） */
export function getEnhancedEngine(): EnhancedEngine {
  return (g.__binanceRadarEnhanced ??= new EnhancedEngine());
}

/** 热重置：停掉旧实例定时器，携带 K 线仓库创建新实例（应用新代码，不再重复回填） */
export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced;
  if (old) {
    if (typeof old.stop === 'function') {
      old.stop();
    } else {
      // 旧原型实例（无 stop 方法）：运行时字段可直接访问，手动清定时器防双实例出站
      const legacy = old as unknown as {
        timers?: ReturnType<typeof setInterval>[];
        bootBackfillAborted?: boolean;
      };
      if (legacy.timers?.length) {
        for (const t of legacy.timers) clearInterval(t);
        legacy.timers = [];
      }
      if ('bootBackfillAborted' in legacy) legacy.bootBackfillAborted = true;
    }
  }
  const fresh = new EnhancedEngine(old?.store);
  g.__binanceRadarEnhanced = fresh;
  return fresh;
}
