// ---------- 趋势跟踪服务（Universal Trend Engine 集成 · Task 54 v2） ----------
// 职责：候选交易对管理（异动事件 + 主动探针双通道）、1m K 线按需刷新（480 根，
// 聚合 5m/15m）、UTE 趋势评估调度、波动率特征计算、趋势生命周期（END_PENDING/
// ENDED/DATA_UNAVAILABLE）管理、统一信号（UnifiedTrendSignal）输出与持久化。
//
// 分工纪律（Task 53 定版 + Task 54 扩展）：Radar 负责行情采集与异动检测（不改）；
// UTE 负责趋势方向判断、评分与确认（vendor 包，不复制/改写其算法）；本服务只做
// 数据整形、门控、候选选择与生命周期管理——方向结论唯一来自 UTE。
//
// 生命周期：绑定 EnhancedEngine——engine.boot() 时 ensureStarted()（幂等，从 DB 恢复
// 候选池、UTE 确认历史与生命周期状态），engine.stop() 时停表。单例由 engine 单例保证。
//
// 请求预算：池内 ≤20 标的 × 1 req/60s（480 根 = 币安权重 2）+ 主动探针
// ≤PROBE_PER_REBUILD req/30s；并发 ≤3，inflight 去重；不扫描全市场。
//
// ⚠️ 趋势评分为启发式证据分（UTE score 0-100），未经历史回放校准；
//    趋势确认不等于买卖指令（是否交易由 AutoPaperTrader 规则层决定，纯模拟）。

import {
  assessTrend,
  scanAnomalyCandidates,
  toClosedBars,
  type TrendConfig,
  type TrendSignal,
  type TrendState,
  type WatchOhlcvSeries,
} from 'universal-trend-engine';
import { TREND_WATCH, trendEngineConfig } from './config';
import { ensureTrendWatchSchema } from './repo';
import {
  assessHtf,
  computeVolatilityFeatures,
  type HtfAssessment,
  type VolatilityFeatures,
} from './indicators';
import { createLifecycleState, stepLifecycle, type LifecycleState } from './lifecycle';
import type { UnifiedTrendSignal } from './signal';
import type {
  EnhancedEventLike,
  TrendCandle,
  TrendPoolEntry,
  TrendTickerSnap,
  TrendWatchDeps,
  TrendWatchRow,
  TrendWatchSnapshot,
  TrendWatchStats,
} from './types';

const INTERVAL_MS = 60_000; // 1m 周期
const MARKET = 'futures';
const INTERVAL = '1m';

/** 异动上下文（候选依据；展示「异动原因/方向冲突」用） */
interface AnomalyCtx {
  dir: 'UP' | 'DOWN';
  level: 'MINOR' | 'MAJOR';
  priority: 'P1' | 'P2' | 'P3';
  active: boolean;
  kinds: string[];
  breakoutConfirmed: boolean;
  volumeMultiple: number | null;
  updatedAt: number;
}

function baseOf(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function toCtx(ev: EnhancedEventLike): AnomalyCtx {
  return {
    dir: ev.dir,
    level: ev.level,
    priority: ev.priority,
    active: ev.state === 'ACTIVE',
    kinds: [...new Set(ev.evidence.map((e) => e.kind))],
    breakoutConfirmed: ev.breakout.status === 'CONFIRMED',
    volumeMultiple: ev.volumeMultiple,
    updatedAt: ev.updatedAt,
  };
}

/** 防御性清洗：只留有限数值行，升序（三所适配器已归一化，此处兜底） */
function cleanCandles(candles: TrendCandle[]): TrendCandle[] {
  return candles
    .filter(
      (c) =>
        Number.isFinite(c.t) && c.t > 0 &&
        Number.isFinite(c.o) && c.o > 0 &&
        Number.isFinite(c.h) && c.h > 0 &&
        Number.isFinite(c.l) && c.l > 0 &&
        Number.isFinite(c.c) && c.c > 0 &&
        Number.isFinite(c.qv) && c.qv >= 0,
    )
    .sort((a, b) => a.t - b.t);
}

function seriesOf(symbol: string, clean: TrendCandle[]): WatchOhlcvSeries {
  return {
    symbol,
    barMs: clean.map((c) => c.t),
    opens: clean.map((c) => c.o),
    highs: clean.map((c) => c.h),
    lows: clean.map((c) => c.l),
    closes: clean.map((c) => c.c),
    vols: clean.map((c) => c.qv), // 计价成交额（USDT）作为量
  };
}

export class TrendWatchService {
  private readonly deps: TrendWatchDeps;
  private readonly trendCfg: Partial<TrendConfig> = trendEngineConfig();

  // —— 生命周期 ——
  private started = false;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private restoredFromDb = 0;

  // —— 内存态 ——
  private pool = new Map<string, TrendPoolEntry>();
  private states = new Map<string, TrendState>();
  private lastSignals = new Map<string, TrendSignal>();
  private anomalyCtx = new Map<string, AnomalyCtx>();
  private inflight = new Set<string>();
  /** Task 54：生命周期状态与统一信号（面板/自动交易共同消费） */
  private lifecycles = new Map<string, LifecycleState>();
  private v2Signals = new Map<string, UnifiedTrendSignal>();

  // —— Task 54：主动探针（仅当 deps.probe=true 时启用，测试注入默认关闭） ——
  private probeQueue: string[] = [];
  private probeQueueBuiltAt = 0;
  private probeInflight = new Set<string>();

  // —— 计数 ——
  klineReqs = 0;
  probeReqs = 0;
  dbWrites = 0;
  dbErrors = 0;
  lastScanAt = 0;
  lastRebuildAt = 0;

  constructor(deps: TrendWatchDeps) {
    this.deps = deps;
  }

  // ============ 生命周期 ============

  /** 幂等启动：从 DB 恢复候选池、UTE 确认历史与生命周期状态，再启动扫描定时器 */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, new Promise((r) => setTimeout(r, 6000))]);
      return;
    }
    this.started = true;
    this.stopped = false;
    this.startedAt = Date.now();
    this.starting = this.boot().finally(() => {
      this.starting = null; // 完成后清空：stop → ensureStarted 可安全重入
    });
    await Promise.race([this.starting, new Promise((r) => setTimeout(r, 6000))]);
  }

  private async boot(): Promise<void> {
    // 0) 幂等 schema 迁移：v2 新列（SQLite ADD COLUMN 无损；运行中服务免 prisma generate）
    try {
      await ensureTrendWatchSchema();
    } catch (e) {
      this.dbErrors++;
      console.warn('[trend-watch] schema 迁移失败：', e instanceof Error ? e.message : e);
    }
    // 1) 恢复候选池、确认历史与生命周期状态（重启后 confirmed/candidate/END_PENDING 不丢）
    try {
      const records = await this.deps.repo.loadActive();
      for (const rec of records) {
        const now = Date.now();
        this.pool.set(rec.symbol, {
          symbol: rec.symbol,
          addedAt: rec.addedAt,
          lastAnomalyAt: rec.lastAnomalyAt ?? rec.addedAt,
          expiresAt: rec.expiresAt ?? now + TREND_WATCH.CANDIDATE_TTL_MS,
          lastEntryScore: 0,
          lastWeakAt: 0,
          lastKlineAt: rec.lastKlineAt ?? 0,
          lastBarTime: rec.lastBarTime,
          dataMissing: false,
          confirmedLeftAt: null,
          entryChannel: 'restored',
        });
        // 恢复 UTE 状态（含 lastObservationKey——同根 K 线去重在重启后仍然生效）
        try {
          const st = JSON.parse(rec.trendStateJson) as TrendState;
          if (st && typeof st.symbol === 'string') this.states.set(rec.symbol, st);
        } catch {
          // JSON 损坏：该标的从 idle 重新确认（不阻断其他标的恢复）
        }
        // 恢复生命周期状态（END_PENDING 证据计数/周期 id；损坏则从 OBSERVING 重建）
        try {
          const lc = JSON.parse(rec.lifecycleStateJson || '{}') as LifecycleState;
          if (lc && lc.symbol === rec.symbol && typeof lc.phase === 'string') {
            this.lifecycles.set(rec.symbol, lc);
          }
        } catch {
          this.lifecycles.set(rec.symbol, createLifecycleState(rec.symbol));
        }
      }
      this.restoredFromDb = records.length;
    } catch (e) {
      this.dbErrors++;
      console.warn('[trend-watch] loadActive 失败：', e instanceof Error ? e.message : e);
      // 恢复失败不阻断服务（池从零重建，异动事件会重新填充）
    }
    // 2) 扫描定时器（到期检查粒度 = SCAN_MS）
    this.timer = setInterval(() => this.tick(), TREND_WATCH.SCAN_MS);
  }

  /** 停止扫描（engine 热重置时调用；inflight 请求自然完成但不派发新任务） */
  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ============ 主扫描循环 ============

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    this.lastScanAt = now;
    if (now - this.lastRebuildAt >= TREND_WATCH.REBUILD_MS) {
      this.lastRebuildAt = now;
      this.rebuildPool(now);
    }
    this.refreshDue(now);
  }

  // ============ 候选筛选（评分 + 迟滞 + 上限 + 退出） ============

  /** 候选选择分（非 UTE 趋势分）：按异动证据质量排序；工程参数未经回测校准 */
  private scoreOf(ctx: AnomalyCtx, now: number): number {
    const c = TREND_WATCH;
    let score = 0;
    score += ctx.priority === 'P1' ? c.wPriorityP1 : ctx.priority === 'P2' ? c.wPriorityP2 : c.wPriorityP3;
    score += ctx.level === 'MAJOR' ? c.wMajor : c.wMinor;
    score += Math.min(3, ctx.kinds.length) * c.wEvidenceEach;
    if (ctx.breakoutConfirmed) score += c.wBreakoutConfirmed;
    if (ctx.volumeMultiple != null && ctx.volumeMultiple > 0) {
      score += Math.min(c.wVolumeMultCap, ctx.volumeMultiple * c.wVolumeMultPer);
    }
    if (ctx.active) {
      score += c.wActiveFresh;
    } else {
      const decay = Math.max(0, 1 - (now - ctx.updatedAt) / c.endedDecayMs);
      score += c.wActiveFresh * decay;
    }
    return score;
  }

  /** 流动性门控：≥500 万正常参与；100~500 万仅 MAJOR+（有效突破 或 ≥3 种独立证据）例外入池 */
  private liquidityOk(ctx: AnomalyCtx, qv24: number): boolean {
    if (qv24 >= TREND_WATCH.QV_NORMAL) return true;
    if (qv24 < TREND_WATCH.QV_EXCEPTION) return false;
    return (
      ctx.level === 'MAJOR' &&
      (ctx.breakoutConfirmed || ctx.kinds.length >= TREND_WATCH.EXCEPTION_MIN_KINDS)
    );
  }

  private rebuildPool(now: number): void {
    const { active, ended } = this.deps.getEvents(now);
    const tickers = new Map<string, TrendTickerSnap>(
      this.deps.getTickers().map((t) => [t.symbol, t]),
    );

    // 1) 每 symbol 取最佳异动候选（active 全算；ended 只算衰减期内）
    const best = new Map<string, { ctx: AnomalyCtx; score: number }>();
    for (const ev of [...active, ...ended]) {
      if (ev.state === 'ENDED' && now - ev.updatedAt > TREND_WATCH.endedDecayMs) continue;
      const ctx = toCtx(ev);
      const score = this.scoreOf(ctx, now);
      const prev = best.get(ev.symbol);
      if (!prev || score > prev.score) best.set(ev.symbol, { ctx, score });
    }

    // 2) 入池/续期（分数降序；迟滞：在池保留下限低于入池下限）
    const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score);
    let poolChanged = false;
    for (const [sym, { ctx, score }] of ranked) {
      const entry = this.pool.get(sym);
      const keepMin = entry
        ? TREND_WATCH.SCORE_MIN_ENTRY - TREND_WATCH.SCORE_HYSTERESIS
        : TREND_WATCH.SCORE_MIN_ENTRY;
      const ticker = tickers.get(sym);
      const liqOk = this.liquidityOk(ctx, ticker?.quoteVolume24h ?? 0);
      this.anomalyCtx.set(sym, ctx); // 上下文始终刷新（展示层用）

      if (score >= keepMin && liqOk) {
        if (!entry) {
          if (this.pool.size >= TREND_WATCH.MAX_TREND_SYMBOLS) continue; // 满员：等退池释放
          this.pool.set(sym, {
            symbol: sym,
            addedAt: now,
            lastAnomalyAt: ctx.active ? now : ctx.updatedAt,
            expiresAt: now + TREND_WATCH.CANDIDATE_TTL_MS,
            lastEntryScore: score,
            lastWeakAt: 0,
            lastKlineAt: 0,
            lastBarTime: null,
            dataMissing: false,
            confirmedLeftAt: null,
            entryChannel: 'anomaly',
          });
          poolChanged = true;
          void this.persistUpsert(sym, now);
        } else if (ctx.active) {
          // 活跃异动续期：刷新 TTL 起点（迟滞宽限同时解除）
          entry.lastAnomalyAt = now;
          entry.lastEntryScore = score;
          entry.lastWeakAt = 0;
          const newExp = now + TREND_WATCH.CANDIDATE_TTL_MS;
          if (newExp > entry.expiresAt) entry.expiresAt = newExp;
          poolChanged = true;
        }
      } else if (entry && !entry.lastWeakAt) {
        entry.lastWeakAt = now; // 弱化起点（仅记录；实际退池在下面统一判定）
      }
    }

    // 3) 退池扫描（candidate/confirmed 保留规则见 config 注释）
    for (const [sym, entry] of this.pool) {
      const st = this.states.get(sym);
      const phase = st?.phase ?? 'idle';
      const expired = now > entry.expiresAt;
      const sinceAnomaly = now - entry.lastAnomalyAt;
      const staleData =
        entry.lastKlineAt > 0 && now - entry.lastKlineAt >= TREND_WATCH.STALE_DATA_EXIT_MS;

      let retire = false;
      if (staleData) {
        retire = true; // 数据断供（任何相位，含 confirmed——没数据就无法跟踪）
      } else if (phase === 'confirmed') {
        retire = false; // 已确认趋势：不因事件结束退池（回落 idle 后走下面的宽限）
      } else if (phase === 'candidate') {
        // 候选趋势：UTE 正在积累确认——过期后再给一个完整 TTL 的确认窗口
        retire = expired && sinceAnomaly >= TREND_WATCH.CANDIDATE_TTL_MS;
      } else {
        // idle：过期后再给 IDLE_EXIT_MS 宽限（从过期点起算；期间新异动会续期解除）；
        // 或曾确认回落 idle 后的宽限
        const leftIdle =
          entry.confirmedLeftAt != null &&
          now - entry.confirmedLeftAt >= TREND_WATCH.CONFIRMED_IDLE_EXIT_MS;
        const graceAfterExpiry = now - entry.expiresAt >= TREND_WATCH.IDLE_EXIT_MS;
        retire = (expired && graceAfterExpiry) || leftIdle;
      }

      if (retire) {
        this.evictSymbol(sym);
        poolChanged = true;
      }
    }

    // 4) 上限裁剪（保险：正常流程满员不入，这里处理恢复/并发导致的超员）
    if (this.pool.size > TREND_WATCH.MAX_TREND_SYMBOLS) {
      const retainRank = (sym: string) => {
        const st = this.states.get(sym);
        const phase = st?.phase ?? 'idle';
        const phaseW = phase === 'confirmed' ? 3 : phase === 'candidate' ? 2 : 1;
        const score = this.anomalyCtx.has(sym) ? this.scoreOf(this.anomalyCtx.get(sym)!, now) : 0;
        return phaseW * 1000 + score;
      };
      const ordered = [...this.pool.keys()].sort((a, b) => retainRank(b) - retainRank(a));
      for (const sym of ordered.slice(TREND_WATCH.MAX_TREND_SYMBOLS)) {
        this.evictSymbol(sym);
        poolChanged = true;
      }
    }

    if (poolChanged) this.lastRebuildAt = now; // 有变化时不必立即再重建（防抖）

    // 5) Task 54：主动探针通道（不依赖异动事件的候选发现；预算可配）
    this.maybeProbe(now, [...tickers.values()]);
  }

  /** 统一退池：清空全部内存态并标记 DB RETIRED（重新入池则从零重新确认） */
  private evictSymbol(sym: string): void {
    this.pool.delete(sym);
    this.anomalyCtx.delete(sym);
    this.lastSignals.delete(sym);
    this.states.delete(sym);
    this.lifecycles.delete(sym);
    this.v2Signals.delete(sym);
    void this.persistRetire(sym);
  }

  // ============ 主动探针通道（Task 54 §2.1：兼顾「正在形成趋势」） ============
  // 从可交易合约宇宙按成交额轮换探测未入池标的：用「形成中趋势」特征组合
  // （ER/一致性/量比/区间扩张达标 + 窗口收益未走完）判准入池；只做候选选择，
  // 方向结论仍由入池后的 UTE 正式评估给出。

  private maybeProbe(now: number, tickers: TrendTickerSnap[]): void {
    if (!this.deps.probe) return; // 测试注入默认关闭；生产（engine）开启
    if (this.pool.size >= TREND_WATCH.MAX_TREND_SYMBOLS) return;
    if (this.probeInflight.size > 0) return; // 上轮探针未完成不叠加（请求预算护栏）
    if (
      now - this.probeQueueBuiltAt >= TREND_WATCH.REBUILD_MS * 2 ||
      this.probeQueue.length === 0
    ) {
      this.probeQueue = tickers
        .filter(
          (t) =>
            t.price > 0 &&
            t.quoteVolume24h >= TREND_WATCH.PROBE_QV_MIN &&
            !this.pool.has(t.symbol),
        )
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
        .map((t) => t.symbol);
      this.probeQueueBuiltAt = now;
    }
    let budget = TREND_WATCH.PROBE_PER_REBUILD;
    while (
      budget > 0 &&
      this.probeQueue.length > 0 &&
      this.pool.size + this.probeInflight.size < TREND_WATCH.MAX_TREND_SYMBOLS
    ) {
      const sym = this.probeQueue.shift()!;
      if (this.pool.has(sym) || this.inflight.has(sym) || this.probeInflight.has(sym)) continue;
      budget--;
      this.probeInflight.add(sym);
      void this.probeSymbol(sym).finally(() => this.probeInflight.delete(sym));
    }
  }

  /** 探测单标的：480 根 1m → 已收盘 → 特征「形成中趋势」判准 → 入池（不动方向状态） */
  private async probeSymbol(symbol: string): Promise<void> {
    try {
      const now = Date.now();
      const ticker = this.deps.getTickers().find((t) => t.symbol === symbol);
      if (!ticker || !(ticker.price > 0) || now - ticker.updatedAt > TREND_WATCH.MAX_TICK_AGE_MS) return;
      if (this.pool.has(symbol) || this.pool.size >= TREND_WATCH.MAX_TREND_SYMBOLS) return;
      this.probeReqs++;
      const candles = await this.deps.fetchKlines(symbol, TREND_WATCH.KLINE_BARS_V2);
      const clean = cleanCandles(candles);
      const closed = toClosedBars(seriesOf(symbol, clean), INTERVAL_MS, Date.now());
      if (closed.length < TREND_WATCH.MIN_CLOSED_BARS) return; // 数据量不足：不冒充有效特征
      const assessment = assessTrend(closed, { now: Date.now() }, this.trendCfg);
      const f = assessment.features;
      const vol = computeVolatilityFeatures(closed);
      if (!f || f.barsUsed < TREND_WATCH.MIN_CLOSED_BARS) return;
      const forming =
        assessment.direction !== 'flat' &&
        f.directionalConsistency >= TREND_WATCH.PROBE_CONSISTENCY_MIN &&
        vol.efficiencyRatio >= TREND_WATCH.PROBE_ER_MIN &&
        f.volumeRatio >= TREND_WATCH.PROBE_VOLUME_RATIO_MIN &&
        f.rangeExpansion >= TREND_WATCH.PROBE_RANGE_EXPANSION_MIN &&
        Math.abs(f.returnPct) <= TREND_WATCH.PROBE_RETURN_MAX_PCT;
      if (!forming) return;
      if (this.pool.has(symbol) || this.pool.size >= TREND_WATCH.MAX_TREND_SYMBOLS) return;
      const now2 = Date.now();
      this.pool.set(symbol, {
        symbol,
        addedAt: now2,
        lastAnomalyAt: now2,
        expiresAt: now2 + TREND_WATCH.CANDIDATE_TTL_MS,
        lastEntryScore: 0,
        lastWeakAt: 0,
        lastKlineAt: 0,
        lastBarTime: null,
        dataMissing: false,
        confirmedLeftAt: null,
        entryChannel: 'probe',
      });
      void this.persistUpsert(symbol, now2);
    } catch {
      // 探针失败静默：下轮重建会重新入队
    }
  }

  // ============ K 线刷新与 UTE 评估 ============

  /** 刷新优先级：confirmed > candidate > 从未刷新过的新入池 > 按最近刷新时间最旧优先 */
  private refreshDue(now: number): void {
    const due = [...this.pool.values()]
      .filter((e) => now - e.lastKlineAt >= TREND_WATCH.KLINE_INTERVAL_MS)
      .sort((a, b) => {
        const phaseOf = (sym: string) => this.states.get(sym)?.phase ?? 'idle';
        const w = (sym: string) =>
          phaseOf(sym) === 'confirmed' ? 2 : phaseOf(sym) === 'candidate' ? 1 : 0;
        return w(b.symbol) - w(a.symbol) || a.lastKlineAt - b.lastKlineAt;
      });
    for (const entry of due) {
      if (this.inflight.size >= TREND_WATCH.KLINE_CONCURRENCY) break;
      if (this.inflight.has(entry.symbol)) continue;
      void this.refreshSymbol(entry.symbol);
    }
  }

  /** 数据不可用：标记 DATA_UNAVAILABLE（不伪装趋势结束；恢复后按正常规则继续） */
  private markDataUnavailable(symbol: string, reason: string, now: number): void {
    const entry = this.pool.get(symbol);
    if (!entry) return;
    entry.dataMissing = true;
    const lc = this.lifecycles.get(symbol) ?? createLifecycleState(symbol);
    const prevPhaseV2 = lc.phase;
    const res = stepLifecycle(lc, {
      utePhase: 'idle',
      uteDirection: 'flat',
      uteCandidateDirection: 'flat',
      directionalConsistency: 0,
      returnPct: 0,
      barTime: null,
      uteChangedAt: null,
      uteConfirmCount: 0,
      uteScore: 0,
      strength: 0,
      features: null,
      dataOk: false,
      now,
    });
    this.lifecycles.set(symbol, res.state); // 写回（同 refreshSymbol 纪律）
    const prevV2 = this.v2Signals.get(symbol);
    this.v2Signals.set(
      symbol,
      this.buildSignalV2({
        symbol,
        entry,
        lc: res.state,
        ute: this.lastSignals.get(symbol) ?? null,
        vol: prevV2?.features ?? null,
        htf5m: prevV2?.htf5m ?? null,
        htf15m: prevV2?.htf15m ?? null,
        dataOk: false,
        dataReason: reason,
        reason: res.reason,
        now,
      }),
    );
    if (prevPhaseV2 !== res.state.phase) void this.persistUpsert(symbol, now);
  }

  /** 单标的刷新 + 评估（inflight 去重：同一标的绝不并发重复请求） */
  private async refreshSymbol(symbol: string): Promise<void> {
    if (this.inflight.has(symbol)) return;
    this.inflight.add(symbol);
    const entry = this.pool.get(symbol);
    if (!entry || this.stopped) {
      this.inflight.delete(symbol);
      return;
    }
    try {
      const now = Date.now();
      // ① 行情有效性门控：最新行情有效才参与趋势判断（无效时不浪费 K 线请求）
      const ticker = this.deps.getTickers().find((t) => t.symbol === symbol);
      if (!ticker || !(ticker.price > 0) || now - ticker.updatedAt > TREND_WATCH.MAX_TICK_AGE_MS) {
        this.markDataUnavailable(symbol, '行情缺失或过期（>10s）', now);
        return;
      }
      // ② 拉真实合约 K 线（归属源分片 + 多源兜底 + 令牌桶限速由 collector 统一处理）
      // 请求发出即计数（含失败），与 collector.klineReqs 口径一致
      this.klineReqs++;
      const candles = await this.deps.fetchKlines(symbol, TREND_WATCH.KLINE_BARS_V2);
      entry.lastKlineAt = Date.now();
      // ③ 防御性清洗
      const clean = cleanCandles(candles);
      const series = seriesOf(symbol, clean);
      // ④ UTE toClosedBars：剔除未收盘 K 线与非法 OHLCV（绝不从 close 估造 high/low）
      const now2 = Date.now();
      const closed = toClosedBars(series, INTERVAL_MS, now2);
      if (closed.length < TREND_WATCH.MIN_CLOSED_BARS) {
        this.markDataUnavailable(
          symbol,
          `已收盘 K 线不足（${closed.length}/${TREND_WATCH.MIN_CLOSED_BARS}）`,
          now2,
        );
        return;
      }
      entry.dataMissing = false;
      // ⑤ UTE 趋势评估（方向由价格序列独立判断，不强制等于异动方向；
      //    同根已收盘 K 线重复轮询不会累计确认——UTE lastObservationKey 保证）
      const ctx = this.anomalyCtx.get(symbol);
      const result = scanAnomalyCandidates(
        [{ series, anomalyFlag: ctx?.active ?? false }],
        this.states,
        now2,
        this.trendCfg,
        INTERVAL_MS,
      );
      const signal = result.signals.find((s) => s.symbol === symbol);
      if (!signal) return;
      const prev = this.lastSignals.get(symbol);
      this.states.set(symbol, signal);
      this.lastSignals.set(symbol, signal);
      // ⑥ Task 54：波动率特征 + 高周期过滤 + 生命周期推进（方向唯一来源仍是 UTE）
      const features = computeVolatilityFeatures(closed);
      const htfCfg = { lookbackBars: TREND_WATCH.lookbackBars, minMovePct: TREND_WATCH.minMovePct };
      const htf5m = assessHtf(closed, 5, now2, htfCfg, (bars, opts) => assessTrend(bars, opts, this.trendCfg));
      const htf15m = assessHtf(closed, 15, now2, htfCfg, (bars, opts) => assessTrend(bars, opts, this.trendCfg));
      const lastBarTime = signal.assessment.features?.latestBarTime ?? null;
      const staleBar =
        lastBarTime != null && now2 - (lastBarTime + INTERVAL_MS) > TREND_WATCH.KLINE_STALE_MS;
      const uteEligible = signal.assessment.eligible && signal.assessment.features != null;
      const dataOk = !staleBar && uteEligible;
      const lc = this.lifecycles.get(symbol) ?? createLifecycleState(symbol);
      const strength = Math.max(
        0,
        Math.min(
          1,
          Math.abs(signal.assessment.features?.returnPct ?? 0) /
            (TREND_WATCH.minMovePct * 3),
        ),
      );
      const res = stepLifecycle(lc, {
        utePhase: signal.phase,
        uteDirection: signal.direction,
        uteCandidateDirection: signal.candidateDirection,
        directionalConsistency: signal.assessment.features?.directionalConsistency ?? 0,
        returnPct: signal.assessment.features?.returnPct ?? 0,
        barTime: lastBarTime,
        uteChangedAt: signal.changedAt,
        uteConfirmCount: signal.consecutiveObservations,
        uteScore: signal.lastScore,
        strength,
        features: uteEligible ? features : null,
        dataOk,
        now: now2,
      });
      // ⚠️ 状态机产出为新对象：必须写回 map，否则生命周期永不推进（回放发现的生产 bug）
      this.lifecycles.set(symbol, res.state);
      const prevPhaseV2 = lc.phase;
      // ⑦ 相位迁移记账（confirmed 回落 idle 时启动宽限）
      const prevPhase = prev?.phase ?? 'idle';
      if (prevPhase === 'confirmed' && signal.phase !== 'confirmed') {
        entry.confirmedLeftAt = now2;
      }
      if (signal.phase === 'confirmed') entry.confirmedLeftAt = null;
      entry.lastBarTime = lastBarTime ?? entry.lastBarTime;
      // ⑧ 统一信号（面板/自动交易/回放共同消费的唯一信封）
      this.v2Signals.set(
        symbol,
        this.buildSignalV2({
          symbol,
          entry,
          lc: res.state,
          ute: signal,
          vol: features,
          htf5m,
          htf15m,
          dataOk,
          dataReason: dataOk
            ? null
            : staleBar
              ? '最新收盘 K 线过期（>3min 未更新）'
              : 'UTE 评估不可用（K 线不足/过期）',
          reason: res.reason,
          now: now2,
        }),
      );
      // ⑨ 持久化：仅新 K 线 / 状态变化 / 方向变化时写库（不每轮扫描无条件写）
      const isNewBar =
        lastBarTime != null &&
        lastBarTime !== prev?.assessment.features?.latestBarTime;
      const phaseChanged = signal.phase !== prevPhase || prevPhaseV2 !== res.state.phase;
      const dirChanged = signal.direction !== (prev?.direction ?? 'flat');
      if (isNewBar || phaseChanged || dirChanged) {
        void this.persistUpsert(symbol, now2);
      }
    } catch {
      this.markDataUnavailable(symbol, 'K 线拉取失败/数据异常', Date.now());
    } finally {
      this.inflight.delete(symbol);
    }
  }

  // ============ 统一信号构建（Task 54 §2.4） ============

  private buildSignalV2(input: {
    symbol: string;
    entry: TrendPoolEntry;
    lc: LifecycleState;
    ute: TrendSignal | null;
    vol: VolatilityFeatures | null;
    htf5m: HtfAssessment | null;
    htf15m: HtfAssessment | null;
    dataOk: boolean;
    dataReason: string | null;
    reason: string;
    now: number;
  }): UnifiedTrendSignal {
    const { symbol, entry, lc, ute, vol, htf5m, htf15m, dataOk, dataReason, now } = input;
    const ctx = this.anomalyCtx.get(symbol);
    const dir = ute?.direction ?? 'flat';
    const cycleDir = lc.cycleDir;
    const htfAgree =
      cycleDir !== 'flat' && htf15m?.valid ? htf15m.dir === cycleDir : null;
    const uteReason = ute?.assessment.reason ?? '';
    const conflict =
      (dir !== 'flat' || cycleDir !== 'flat') &&
      ctx?.dir != null &&
      ((cycleDir !== 'flat' ? cycleDir : dir) === 'up') !== (ctx.dir === 'UP');
    const trendDir = cycleDir !== 'flat' ? cycleDir : dir;
    return {
      symbol,
      market: MARKET,
      interval: INTERVAL,
      phase: lc.phase,
      direction: trendDir,
      trendCycleId: lc.cycleId,
      trendStartedAt: lc.cycleStartedAt,
      endPendingSince: lc.endPendingSince,
      endEvidenceBars: lc.endEvidenceBars,
      endedAt: lc.endedAt,
      endReason: lc.endReason,
      score: ute?.lastScore ?? 0,
      strength: ute
        ? Math.max(
            0,
            Math.min(1, Math.abs(ute.assessment.features?.returnPct ?? 0) / (TREND_WATCH.minMovePct * 3)),
          )
        : 0,
      confirmCount: ute?.consecutiveObservations ?? 0,
      features:
        vol ?? {
          atr: 0, atrPct: 0, realizedVolPct: 0, volPercentile: -1, volRegime: 'NORMAL',
          efficiencyRatio: 0, upperWickPct: 0, lowerWickPct: 0, breakout: 'none',
          falseBreakout: false, barsUsed: 0,
        },
      htf5m: htf5m ?? { dir: 'flat', efficiencyRatio: 0, returnPct: 0, valid: false, bars: 0 },
      htf15m: htf15m ?? { dir: 'flat', efficiencyRatio: 0, returnPct: 0, valid: false, bars: 0 },
      htfAgree,
      lastBarTime: entry.lastBarTime,
      lastKlineAt: entry.lastKlineAt,
      dataFresh: dataOk && !entry.dataMissing,
      dataUnavailableReason: dataOk && !entry.dataMissing ? null : dataReason ?? '数据不可用',
      anomaly: {
        dir: ctx?.dir ?? null,
        level: ctx?.level ?? null,
        priority: ctx?.priority ?? null,
        active: ctx?.active ?? false,
        lastAt: entry.lastAnomalyAt,
      },
      conflict,
      reason: uteReason ? `${input.reason}；UTE：${uteReason}` : input.reason,
      changedAt: now,
    };
  }

  // ============ 持久化 ============

  private recordFor(symbol: string, now: number) {
    const entry = this.pool.get(symbol);
    const st = this.states.get(symbol);
    const signal = this.lastSignals.get(symbol);
    const lc = this.lifecycles.get(symbol);
    return {
      symbol,
      market: MARKET,
      interval: INTERVAL,
      status: 'WATCHING' as const,
      addedAt: entry?.addedAt ?? now,
      lastAnomalyAt: entry?.lastAnomalyAt ?? null,
      expiresAt: entry?.expiresAt ?? null,
      trendStateJson: JSON.stringify(st ?? { symbol, phase: 'idle' }),
      lastSignalJson: signal ? JSON.stringify(signal) : null,
      lastPhase: st?.phase ?? 'idle',
      lastDirection: st?.direction ?? 'flat',
      lastScore: st?.lastScore ?? 0,
      lastBarTime: entry?.lastBarTime ?? null,
      lastKlineAt: entry?.lastKlineAt ? entry.lastKlineAt : null,
      lifecycleStateJson: JSON.stringify(lc ?? createLifecycleState(symbol)),
      trendCycleId: lc?.cycleId ?? null,
      lastPhaseV2: lc?.phase ?? 'OBSERVING',
      endReason: lc?.endReason ?? null,
    };
  }

  private async persistUpsert(symbol: string, now: number): Promise<void> {
    try {
      await this.deps.repo.upsert(this.recordFor(symbol, now));
      this.dbWrites++;
    } catch (e) {
      this.dbErrors++;
      console.warn('[trend-watch] upsert 失败：', e instanceof Error ? e.message : e);
    }
  }

  private async persistRetire(symbol: string): Promise<void> {
    try {
      await this.deps.repo.markRetired(symbol, MARKET, INTERVAL);
      this.dbWrites++;
    } catch (e) {
      this.dbErrors++;
      console.warn('[trend-watch] markRetired 失败：', e instanceof Error ? e.message : e);
    }
  }

  // ============ 对外查询 ============

  /** 统一趋势信号（Task 54：AutoPaperTrader 消费入口——不再另行计算趋势） */
  latestSignals(): UnifiedTrendSignal[] {
    return [...this.v2Signals.values()];
  }

  signalOf(symbol: string): UnifiedTrendSignal | null {
    return this.v2Signals.get(symbol) ?? null;
  }

  snapshot(now: number): TrendWatchSnapshot {
    const tickers = new Map<string, TrendTickerSnap>(
      this.deps.getTickers().map((t) => [t.symbol, t]),
    );
    const phaseW = (p: string) =>
      p === 'CONFIRMED_UP' || p === 'CONFIRMED_DOWN'
        ? 0
        : p === 'END_PENDING'
          ? 1
          : p === 'CANDIDATE_UP' || p === 'CANDIDATE_DOWN'
            ? 2
            : p === 'DATA_UNAVAILABLE'
              ? 3
              : 4;
    const rows: TrendWatchRow[] = [];
    for (const [sym, entry] of this.pool) {
      const st = this.states.get(sym);
      const signal = this.lastSignals.get(sym);
      const v2 = this.v2Signals.get(sym);
      const ctx = this.anomalyCtx.get(sym);
      const ticker = tickers.get(sym);
      const lastBar = entry.lastBarTime;
      const phase = st?.phase ?? 'idle';
      const direction = st?.direction ?? 'flat';
      const score = st?.lastScore ?? 0;
      const trendDir = v2?.direction ?? direction;
      const conflict =
        v2?.conflict ??
        (direction !== 'flat' &&
          ctx?.dir != null &&
          (direction === 'up') !== (ctx.dir === 'UP'));
      rows.push({
        symbol: sym,
        base: baseOf(sym),
        phase,
        direction,
        phaseV2: v2?.phase ?? 'OBSERVING',
        trendCycleId: v2?.trendCycleId ?? null,
        trendStartedAt: v2?.trendStartedAt ?? null,
        endPendingSince: v2?.endPendingSince ?? null,
        endEvidenceBars: v2?.endEvidenceBars ?? 0,
        endedAt: v2?.endedAt ?? null,
        endReason: v2?.endReason ?? null,
        strength: v2?.strength ?? 0,
        vol: v2?.features ?? null,
        htf5m: v2?.htf5m ?? null,
        htf15m: v2?.htf15m ?? null,
        htfAgree: v2?.htfAgree ?? null,
        dataFresh: v2?.dataFresh ?? false,
        dataUnavailableReason: v2?.dataUnavailableReason ?? null,
        entryChannel: entry.entryChannel,
        score,
        reason: signal?.assessment.reason ?? '',
        features: signal?.assessment.features
          ? {
              returnPct: signal.assessment.features.returnPct,
              directionalConsistency: signal.assessment.features.directionalConsistency,
              volumeRatio: signal.assessment.features.volumeRatio,
              breakout: signal.assessment.features.breakout,
              rangeExpansion: signal.assessment.features.rangeExpansion,
              barsUsed: signal.assessment.features.barsUsed,
              latestBarTime: signal.assessment.features.latestBarTime,
            }
          : null,
        consecutiveObservations: st?.consecutiveObservations ?? 0,
        changedAt: st?.changedAt ?? null,
        addedAt: entry.addedAt,
        lastAnomalyAt: entry.lastAnomalyAt,
        expiresAt: entry.expiresAt,
        anomalyDir: ctx?.dir ?? null,
        anomalyLevel: ctx?.level ?? null,
        anomalyPriority: ctx?.priority ?? null,
        anomalyActive: ctx?.active ?? false,
        conflict,
        lastBarTime: lastBar,
        lastKlineAt: entry.lastKlineAt,
        stale:
          lastBar != null && now - (lastBar + INTERVAL_MS) > TREND_WATCH.KLINE_STALE_MS,
        dataMissing: entry.dataMissing,
        price: ticker?.price ?? null,
        quoteVolume24h: ticker?.quoteVolume24h ?? null,
      });
    }
    rows.sort(
      (a, b) =>
        phaseW(a.phaseV2) - phaseW(b.phaseV2) ||
        b.score - a.score ||
        a.symbol.localeCompare(b.symbol),
    );
    const stats: TrendWatchStats = {
      poolSize: this.pool.size,
      maxPoolSize: TREND_WATCH.MAX_TREND_SYMBOLS,
      confirmed: rows.filter((r) => r.phase === 'confirmed').length,
      candidate: rows.filter((r) => r.phase === 'candidate').length,
      watching: rows.filter((r) => r.phase === 'idle').length,
      endPending: rows.filter((r) => r.phaseV2 === 'END_PENDING').length,
      dataUnavailable: rows.filter((r) => r.phaseV2 === 'DATA_UNAVAILABLE').length,
      probeReqs: this.probeReqs,
      klineReqs: this.klineReqs,
      dbWrites: this.dbWrites,
      dbErrors: this.dbErrors,
      lastScanAt: this.lastScanAt,
      lastRebuildAt: this.lastRebuildAt,
      startedAt: this.startedAt,
      restoredFromDb: this.restoredFromDb,
    };
    return { ts: now, interval: INTERVAL, market: MARKET, pool: rows, stats };
  }
}
