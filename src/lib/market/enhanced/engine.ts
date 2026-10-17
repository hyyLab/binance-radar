// ---------- 升级版异动交易 · 引擎单例（Task 50 起扫描 USDT-M 合约） ----------
// 编排：行情有效性检查（§2.2）→ 三检测器（独立）→ 事件聚合器（§七）。
// 数据源（Task 50 定版）：合约多源聚合行情（futures-collector：币安 > Bybit > Gate，
// 品种白名单 = 币安 U 本位永续）+ 本引擎的 1m 合约 K 线仓库
//（滚动 24h 基线 / 自适应阈值 / 放量中位数基准，稳态 ~10 req/min）。
// 单例驻留 globalThis，HMR 不重复启动；只在 /api/enhanced/* 被访问时启动。

import { activeFuturesCollector } from '../futures-collector';
import { isExcludedBase } from '../excluded';
import type { FuturesSourceName } from '../futures-feeds';
import { TrendWatchService } from '../trend-watch/service';
import { prismaTrendWatchRepo } from '../trend-watch/repo';
import { AutoPaperTrader } from '../trend-trade/auto-trader';
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

export class EnhancedEngine {
  store: KlineStore;
  /** 趋势跟踪（Universal Trend Engine 集成）：生命周期随引擎，单例由引擎单例保证 */
  readonly trendWatch: TrendWatchService;
  /** 趋势自动模拟交易（Task 54）：消费 trendWatch 统一信号，纯模拟，独立账户 */
  readonly autoTrader: AutoPaperTrader;
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
    // 趋势服务：数据源与异动事件都从本引擎动态取（箭头函数延迟绑定）；
    // 持久化走 Prisma repo——重建后从 DB 恢复候选池与确认历史，不依赖实例交接；
    // Task 54：主动探针通道开启（engine 常驻场景）
    this.trendWatch = new TrendWatchService({
      fetchKlines: (symbol, limit) =>
        activeFuturesCollector().fetchKlinesFor(symbol, '1m', { limit }),
      getTickers: () => activeFuturesCollector().getTickers(),
      getEvents: (now) => this.events(now),
      repo: prismaTrendWatchRepo,
      probe: true,
    });
    // 自动模拟交易：消费同一份统一信号（不另算趋势）；标记价走合约多源供价
    this.autoTrader = new AutoPaperTrader({
      getSignals: () => this.trendWatch.latestSignals(),
      markPrice: (symbol) =>
        activeFuturesCollector().getTickers().find((t) => t.symbol === symbol)?.price ?? 0,
    });
  }

  /** 停止本实例全部定时器与回填（热重置用，防双实例重复出站） */
  stop(): void {
    this.bootBackfillAborted = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.trendWatch.stop(); // 趋势扫描同步停表（DB 恢复机制保证新实例不丢状态）
    this.autoTrader.stop(); // 自动交易主循环停表（持仓/模式在 DB，新实例 reconcile 恢复）
    this.started = false;
  }

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
    // 0) 启动合约多源采集器（幂等）：币安白名单 + 三源价格/24h 就绪后才有监控清单
    void activeFuturesCollector().ensureStarted();
    // 0.5) 启动趋势跟踪服务与自动模拟交易（幂等；从 DB 恢复候选池/确认历史/持仓关联）
    void this.trendWatch.ensureStarted();
    void this.autoTrader.ensureStarted();
    // 1) 等 collector 就绪（tickers 有数据），再建监控清单
    setTimeout(() => void this.buildWatchlistAndBackfill(), STORE.collectReadyWaitMs);
    // 2) 定时器：2s 检测 / 30s 放量 / 12s 轮换槽 / 5min 清单 / 30s 结束判定
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.volumeTick(), VOLUME_MS));
    this.timers.push(setInterval(() => void this.rotateSlot(), ROTATE_SLOT_MS));
    this.timers.push(setInterval(() => this.rebuildWatchlist(), WATCHLIST_MS));
    this.timers.push(setInterval(() => this.agg.sweep(Date.now()), SWEEP_MS));
  }

  // ============ 监控清单（§2.1/§六） ============
  // 标的宇宙 = futures-collector 聚合行情（品种白名单：币安 U 本位永续，
  // 且已剔除稳定币对/代币化股票；只有可交易品种会出现在 tickers 里）

  private candidateUniverse(): { symbol: string; qv: number }[] {
    const out: { symbol: string; qv: number }[] = [];
    for (const t of activeFuturesCollector().getTickers()) {
      if (t.price <= 0) continue;
      out.push({ symbol: t.symbol, qv: t.quoteVolume24h });
    }
    return out.sort((a, b) => b.qv - a.qv);
  }

  private async buildWatchlistAndBackfill(): Promise<void> {
    if (activeFuturesCollector().getTickers().length === 0) {
      // collector 未就绪，稍后重试
      setTimeout(() => void this.buildWatchlistAndBackfill(), 10_000);
      return;
    }
    if (!activeFuturesCollector().isSharded()) {
      // 分片未就绪（等待首次 24h 统计）：按归属均摊回填前先等分配完成
      setTimeout(() => void this.buildWatchlistAndBackfill(), 10_000);
      return;
    }
    this.rebuildWatchlist();
    if (this.baselineNoteAt.size > 800) this.baselineNoteAt.clear(); // 节流表防膨胀
    // 冷启动回填（Task 51）：按归属源轮流排序——Bybit/Gate 优先就绪，币安只背它分片那份
    //（且被令牌桶二次限速），不再出现「前 125 名全打币安」的突发
    const uni = this.candidateUniverse().filter(
      (c) => c.qv >= 5_000_000 && !this.store.has(c.symbol),
    );
    const byHome: Record<FuturesSourceName, { symbol: string; qv: number }[]> = {
      binance: [],
      bybit: [],
      gate: [],
    };
    for (const c of uni) {
      byHome[activeFuturesCollector().shardOf(c.symbol) ?? 'binance'].push(c);
    }
    const interleaved: { symbol: string; qv: number }[] = [];
    const rounds = Math.max(byHome.binance.length, byHome.bybit.length, byHome.gate.length);
    for (let i = 0; i < rounds; i++) {
      for (const h of ['bybit', 'gate', 'binance'] as const) {
        const c = byHome[h][i];
        if (c) interleaved.push(c);
      }
    }
    const list = interleaved.slice(0, STORE.bootBackfillCap);
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
    for (const t of activeFuturesCollector().getTickers()) {
      if (isExcludedBase(t.base)) continue; // 防御性保留（collector 白名单已剔除）
      if (!(t.price > 0)) continue;
      // 时间戳有效性：供价源 5s 轮询节奏下超过 10s 视为延迟
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
    return {
      symbol: snap.symbol,
      tier: tierOf(snap.quoteVolume24h),
      quoteVolume24h: snap.quoteVolume24h,
      medAbs1m: s ? this.store.medAbsReturn1m(snap.symbol, _now) : null,
      medAbs5m: s ? this.store.medAbsReturn5m(snap.symbol, _now) : null,
      medQv1m: null,
      dataCoverage: s ? this.store.coverage(s, _now) : 0,
      tickSize: activeFuturesCollector().tickSizeOf(snap.symbol) || snap.price * 0.0001,
      tradingOk: true, // 白名单即已通过交易对校验（合约清单只收 TRADING 永续）
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
    for (const t of activeFuturesCollector().getTickers()) {
      const tier = tierOf(t.quoteVolume24h);
      if (tier !== 'NONE' && !isExcludedBase(t.base)) tierCounts[tier]++;
    }
    const tw = this.trendWatch.snapshot(now).stats;
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
      sources: activeFuturesCollector().getSourcesHealth(),
      trendWatch: {
        on: tw.startedAt > 0,
        poolSize: tw.poolSize,
        maxPoolSize: tw.maxPoolSize,
        confirmed: tw.confirmed,
        candidate: tw.candidate,
        klineReqs: tw.klineReqs,
        dbErrors: tw.dbErrors,
      },
      autoTrader: {
        on: this.autoTrader.startedAt > 0,
        opens: this.autoTrader.opens,
        closes: this.autoTrader.closes,
      },
    };
  }
}

function spikeFixedLabel(d: Detection): string {
  if (d.detector === 'SPIKE') return d.windows?.join('+') ?? '1m';
  if (d.detector === 'BREAKOUT') return `24h±${d.magnitude.toFixed(2)}%`;
  return `vol×${d.magnitude.toFixed(1)}`;
}

// ============ 单例（globalThis 驻留，HMR 不重复启动） ============
// v18（Task 66）：两算法复盘定版——短周期套利顺势化（同周期只做第一波 R2 关闭 / SPIKE
//   落袋线 0.6→0.4 / 入场追入保护 ENTRY_CHASE_PCT / 确认新鲜窗 ENTRY_FRESH_MS）+
//   通用趋势引擎方向选择确认制（REQUIRE_DIRECTION_PICK：突破同向或 ER 单边延续才入场，
//   挡震荡内噪声确认）+ 三层离场（STOP_LOSS 硬止损 1% 价格 / TRAIL_TAKE 移动止盈
//   峰值 15% 回撤 8% / 走弱证据 ≥2 根先走）。新离场原因 TRAIL_TAKE/STOP_LOSS 入
//   TrendExitReason。DB strategyParamsJson 的 short-swing 覆盖同步（MAX_ROUNDS=1、
//   SPIKE=0.4）。改行为必 bump key。
// v17（Task 65）：每仓保证金动态槽位配额——用户定版「单一持仓时开最大仓」。
//   effectiveMarginRatio(marginRatioCap, openCount) = min(cap, 95%÷(当前持仓数+1))：
//   单仓自动用满 95% 配额（不再被目标仓数静态均分封死 20%）；并发越多单仓自动越小。
//   MARGIN_RATIO 默认 0.2→0.95（单仓满配）；DB 存量行同步 UPDATE。改行为必 bump key。
// v16（Task 62）：通用趋势引擎算法化——最开始的 Universal Trend Engine（vendor 包，
//   系统唯一趋势信号源）整理为可插拔算法 universal-trend-v1 注册进 STRATEGY_FACTORIES
//   （确认即顺势 / 无评分·ER·5m 门槛 / 走弱先走 ≤2 轮；默认算法仍 short-swing-v1 不变，
//   切换走 UI 下拉）。console-params 参数按策略归属过滤（ParamDef.strategyId）。
//   改行为必 bump key；旧实例 stop() 会同步停掉 autoTrader 主循环，新实例从 DB 恢复
//   持仓关联（reconcile）与策略轮次状态（TrendStrategyState 按 strategyId 存取）。
// v15（Task 59）：手续费 0.02% 双边——用户定版「买入卖出都是 0.02%」。费率改为
//   PaperEngine 实例属性（构造第二参 feeRate）：自动账户 trend-auto-v1 注入
//   TREND_TRADE.FEE_RATE=0.02%（开仓预检与引擎结算同一实例费率，口径不脱钩），
//   手动盘 default 账户仍为默认 Taker 0.05% 行为逐字节不变；paper 引擎单例同步
//   bump（paper v9 / paperAuto v2）。改行为必 bump key；旧实例 stop() 会同步停掉
//   autoTrader 主循环，新实例从 DB 恢复持仓关联（reconcile）——存量持仓已扣的开仓
//   费不变，平仓费按新费率 0.02% 结算（openFee 按仓位记录，逐仓口径不受影响）。
// v13（Task 57-c）：参数控制台——用户可自行调整自动开仓参数（策略门槛/轮次/冲高套利
//   来自 SHORT_SWING 覆盖，二次确认开关/冷却为基础设施列）+ waitBarConfirm 直开路径
//   （关闭二次确认 = 达标当根直接开仓，快 1 根 K 线）+ executeOpen 抽取（pending/direct
//   共用）。改行为必 bump key；旧实例 stop() 会同步停掉 autoTrader 主循环，新实例从 DB
//   恢复持仓关联（reconcile）。
// v14（Task 58）：仓位测算修复——用户反馈「设 8 仓只开出 4 仓就没保证金」：原 sizing
//   每仓固定权益×20%，8×20%=160% 权益物理上不可能开满。改为每仓 = 权益 ×
//   min(marginRatio, 95%÷持仓数)（≤4 仓行为不变；5/6/8 仓自动压为 19%/15.83%/11.875%），
//   95% 预算给手续费与浮动亏损留缓冲；marginRatio 同时接入参数控制台（第 14 参数，infra 域）。
//   改行为必 bump key；旧实例 stop() 会同步停掉 autoTrader 主循环，新实例从 DB 恢复持仓
//   关联（reconcile）。
// v13（Task 57-c）：参数控制台——13 参数热生效（策略域 11 项 SHORT_SWING 覆盖 + infra
//   waitBarConfirm/cooldownMs）+ 直开路径（关二次确认 = 达标当根直接开仓）+ executeOpen
//   抽取共享 + TrendAutoConfig 三新列（strategyParamsJson/waitBarConfirm/cooldownMs）。
//   改行为必 bump key；旧实例 stop() 同步停 autoTrader 主循环，新实例从 DB reconcile。
// v12（Task 57-b）：短周期套利入场门槛下调——趋势起点入场（用户定版：高分≈走势已成熟，
//   趋势起点分数不高）：模式 A score 60→45、模式 B 70→55（ER 守门不变）；清理 config.ts
//   Task 56 死门槛常量（入场门槛自 Task 57 起唯一入口在策略 SHORT_SWING）。改行为必 bump
//   key；旧实例 stop() 会同步停掉 autoTrader 主循环，新实例从 DB 恢复持仓关联（reconcile）。
// v11（Task 57）：策略可插拔重构——通用策略接口（strategy/types.ts + registry）+
//   新策略「短周期套利 v1」（异动选币不问方向 / 1m 确认定多空 + 5m 背景分级 / 冲高套利
//   SPIKE_TAKE / 走弱先走 WEAKNESS_EARLY / 同周期轮次再入场）；决策/待入场键轮次化
//   `{cycleId}#R{round}`；TrendAutoConfig.strategyId + TrendTradeMeta.entryRound +
//   TrendStrategyState 表。改行为必 bump key；旧实例 stop() 会同步停掉 autoTrader 主循环，
//   新实例从 DB 恢复持仓关联（reconcile）。
// v10（Task 56b）：db 单例 bump v2→v3（Prisma 连接永久只读事件，平台快照替换 db 文件
//   inode 后旧连接写全挂）——engine/autoTrader/trendWatch 持有旧 db 引用，必须重建实例
//   才能切到新 client。改行为必 bump key；旧实例 stop() 会同步停掉 autoTrader 主循环，
//   新实例从 DB 恢复持仓关联（reconcile）。
// v9（Task 56）：趋势结束状态机修复（证据幂等键/周期出生 bar 排除/方向感知衰减阈值）+
//   退出 v3（END_PENDING 不平仓、ENDED 周期匹配 + 证据晚于开仓 bar）+ 入场门槛
//   （score/ER/HTF 分级 + 待入场二次确认 + 同币种冷却 5min）+ sizing 改权益 20% +
//   MFE/MAE 采集 + TrendPendingEntry 表。改行为必 bump key；旧实例 stop() 会同步停掉
//   autoTrader 主循环，新实例从 DB 恢复持仓关联（reconcile）。
// v8（Task 55-3）：AutoPaperTrader sizing v2（每仓 = 权益÷持仓数量，余额不足 clamp）
//   + tick 重入锁（防 setInterval 并发轮次双扣余额）。改行为必 bump key；旧实例 stop()
//   会同步停掉 autoTrader 主循环，新实例从 DB 恢复持仓关联（reconcile）。
// v7（Task 55-2）：AutoPaperTrader 退出管理 v2（END_PENDING/ENDED 任意周期归属即自行平仓）
//   + resetAccount（重置账户到 100 U）。改行为必 bump key；旧实例 stop() 会同步停掉
//   autoTrader 主循环，新实例从 DB 恢复持仓关联（reconcile）。
// v6（Task 54b）：修复 TrendWatchService 生命周期状态未写回 map 的 bug（回放发现——
//   END_PENDING/ENDED 永不推进）。v5（Task 54）：集成 AutoPaperTrader + TrendWatchService v2。

const g = globalThis as typeof globalThis & {
  __binanceRadarEnhanced?: EnhancedEngine; // v1（现货，遗留）
  __binanceRadarEnhanced_v2?: EnhancedEngine; // v2（合约，回填按 qv 排序期）
  __binanceRadarEnhanced_v3?: EnhancedEngine; // v3（分片均摊回填）
  __binanceRadarEnhanced_v4?: EnhancedEngine;
  __binanceRadarEnhanced_v5?: EnhancedEngine;
  __binanceRadarEnhanced_v6?: EnhancedEngine;
  __binanceRadarEnhanced_v7?: EnhancedEngine;
  __binanceRadarEnhanced_v8?: EnhancedEngine;
  __binanceRadarEnhanced_v9?: EnhancedEngine;
  __binanceRadarEnhanced_v10?: EnhancedEngine;
  __binanceRadarEnhanced_v11?: EnhancedEngine;
  __binanceRadarEnhanced_v12?: EnhancedEngine;
  __binanceRadarEnhanced_v13?: EnhancedEngine;
  __binanceRadarEnhanced_v14?: EnhancedEngine;
  __binanceRadarEnhanced_v15?: EnhancedEngine;
  __binanceRadarEnhanced_v16?: EnhancedEngine; // v16（Task 62）：注册通用趋势引擎 universal-trend-v1
  __binanceRadarEnhanced_v17?: EnhancedEngine; // v17（Task 65）：每仓保证金动态槽位配额（单仓满配）
  __binanceRadarEnhanced_v18?: EnhancedEngine; // v18（Task 66）：两算法复盘定版（顺势化 + 方向选择确认制 + 三层离场）
};

function pickLegacyEngine(
  g: typeof globalThis & {
    __binanceRadarEnhanced?: EnhancedEngine;
    __binanceRadarEnhanced_v2?: EnhancedEngine;
    __binanceRadarEnhanced_v3?: EnhancedEngine;
    __binanceRadarEnhanced_v4?: EnhancedEngine;
    __binanceRadarEnhanced_v5?: EnhancedEngine;
    __binanceRadarEnhanced_v6?: EnhancedEngine;
    __binanceRadarEnhanced_v7?: EnhancedEngine;
    __binanceRadarEnhanced_v8?: EnhancedEngine;
    __binanceRadarEnhanced_v9?: EnhancedEngine;
    __binanceRadarEnhanced_v10?: EnhancedEngine;
    __binanceRadarEnhanced_v11?: EnhancedEngine;
    __binanceRadarEnhanced_v12?: EnhancedEngine;
    __binanceRadarEnhanced_v13?: EnhancedEngine;
    __binanceRadarEnhanced_v14?: EnhancedEngine;
    __binanceRadarEnhanced_v15?: EnhancedEngine;
    __binanceRadarEnhanced_v16?: EnhancedEngine;
    __binanceRadarEnhanced_v17?: EnhancedEngine;
  },
): EnhancedEngine | undefined {
  return (
    g.__binanceRadarEnhanced_v17 ??
    g.__binanceRadarEnhanced_v16 ??
    g.__binanceRadarEnhanced_v15 ??
    g.__binanceRadarEnhanced_v14 ??
    g.__binanceRadarEnhanced_v13 ??
    g.__binanceRadarEnhanced_v12 ??
    g.__binanceRadarEnhanced_v11 ??
    g.__binanceRadarEnhanced_v10 ??
    g.__binanceRadarEnhanced_v9 ??
    g.__binanceRadarEnhanced_v8 ??
    g.__binanceRadarEnhanced_v7 ??
    g.__binanceRadarEnhanced_v6 ??
    g.__binanceRadarEnhanced_v5 ??
    g.__binanceRadarEnhanced_v4 ??
    g.__binanceRadarEnhanced_v3 ??
    g.__binanceRadarEnhanced_v2 ??
    g.__binanceRadarEnhanced
  );
}

function carryStoreOf(old: EnhancedEngine | undefined): KlineStore | undefined {
  // K 线仓库按市场标签携带：仅当旧仓库也是合约数据时复用（防现货/合约K线混用）
  return old?.store && (old.store as { market?: string }).market === 'futures'
    ? old.store
    : undefined;
}

function stopLegacyEngine(old: EnhancedEngine | undefined): void {
  if (!old) return;
  if (typeof old.stop === 'function') {
    old.stop();
    return;
  }
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

/** 每次读取都取 globalThis 上的当前实例（支持 ?reset=1 热替换，路由不依赖模块级常量） */
export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v18;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v18 = fresh;
  return fresh;
}

/** 热重置：停掉旧实例定时器，携带「同市场」K 线仓库创建新实例（应用新代码，不再重复回填） */
export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v18 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v18 = fresh;
  return fresh;
}
