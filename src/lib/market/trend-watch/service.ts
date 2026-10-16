// ---------- 趋势跟踪服务（Universal Trend Engine 集成） ----------
// 职责：候选交易对管理、1m K 线按需刷新、UTE 趋势评估调度、趋势状态持久化。
// 分工（用户定版）：Radar 负责行情采集与异动检测（不改）；UTE 负责趋势评估、方向判断、
// 评分与状态确认（vendor 包，不复制/改写其算法）；本服务只做数据整形、门控与生命周期管理。
//
// 生命周期：绑定 EnhancedEngine——engine.boot() 时 ensureStarted()（幂等，从 DB 恢复
// 候选池与确认历史），engine.stop() 时停表。单例由 engine 单例保证，不重复启动定时器。
//
// 请求预算：仅对入池候选（≤20 个）拉 1m K 线，每标的 ≥60s 一次，并发 ≤3，
// inflight 去重防同标的重复请求；不扫描全市场。
//
// ⚠️ 趋势评分为启发式证据分（UTE score 0-100），未经历史回放校准；
//    趋势确认不等于买卖指令，第一版不做自动交易。

import {
  scanAnomalyCandidates,
  toClosedBars,
  type TrendConfig,
  type TrendSignal,
  type TrendState,
  type WatchOhlcvSeries,
} from 'universal-trend-engine';
import { TREND_WATCH, trendEngineConfig } from './config';
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

  // —— 计数 ——
  klineReqs = 0;
  dbWrites = 0;
  dbErrors = 0;
  lastScanAt = 0;
  lastRebuildAt = 0;

  constructor(deps: TrendWatchDeps) {
    this.deps = deps;
  }

  // ============ 生命周期 ============

  /** 幂等启动：从 DB 恢复候选池与 UTE 确认历史，再启动扫描定时器 */
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
    // 1) 恢复候选池与确认历史（重启后 confirmed/candidate 相位与观察计数不丢）
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
        });
        // 恢复 UTE 状态（含 lastObservationKey——同根 K 线去重在重启后仍然生效）
        try {
          const st = JSON.parse(rec.trendStateJson) as TrendState;
          if (st && typeof st.symbol === 'string') this.states.set(rec.symbol, st);
        } catch {
          // JSON 损坏：该标的从 idle 重新确认（不阻断其他标的恢复）
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
        this.pool.delete(sym);
        this.anomalyCtx.delete(sym);
        this.lastSignals.delete(sym);
        this.states.delete(sym); // 重新入池则从零重新确认
        poolChanged = true;
        void this.persistRetire(sym);
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
        this.pool.delete(sym);
        this.anomalyCtx.delete(sym);
        this.lastSignals.delete(sym);
        this.states.delete(sym);
        poolChanged = true;
        void this.persistRetire(sym);
      }
    }

    if (poolChanged) this.lastRebuildAt = now; // 有变化时不必立即再重建（防抖）
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
        entry.dataMissing = true;
        return;
      }
      // ② 拉真实合约 K 线（归属源分片 + 多源兜底 + 令牌桶限速由 collector 统一处理）
      // 请求发出即计数（含失败），与 collector.klineReqs 口径一致
      this.klineReqs++;
      const candles = await this.deps.fetchKlines(symbol, TREND_WATCH.KLINE_BARS);
      entry.lastKlineAt = Date.now();
      // ③ 防御性清洗：只留有限数值行，升序（三所适配器已归一化，此处兜底）
      const clean = candles
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
      const series: WatchOhlcvSeries = {
        symbol,
        barMs: clean.map((c) => c.t),
        opens: clean.map((c) => c.o),
        highs: clean.map((c) => c.h),
        lows: clean.map((c) => c.l),
        closes: clean.map((c) => c.c),
        vols: clean.map((c) => c.qv), // 计价成交额（USDT）作为量
      };
      // ④ UTE toClosedBars：剔除未收盘 K 线与非法 OHLCV（绝不从 close 估造 high/low）
      const now2 = Date.now();
      const closed = toClosedBars(series, INTERVAL_MS, now2);
      if (closed.length < TREND_WATCH.MIN_CLOSED_BARS) {
        entry.dataMissing = true;
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
      // ⑥ 相位迁移记账（confirmed 回落 idle 时启动宽限）
      const prevPhase = prev?.phase ?? 'idle';
      if (prevPhase === 'confirmed' && signal.phase !== 'confirmed') {
        entry.confirmedLeftAt = now2;
      }
      if (signal.phase === 'confirmed') entry.confirmedLeftAt = null;
      entry.lastBarTime = signal.assessment.features?.latestBarTime ?? entry.lastBarTime;
      // ⑦ 持久化：仅新 K 线 / 相位变化 / 方向变化时写库（不每轮扫描无条件写）
      const isNewBar =
        signal.assessment.features?.latestBarTime != null &&
        signal.assessment.features!.latestBarTime !== prev?.assessment.features?.latestBarTime;
      const phaseChanged = signal.phase !== prevPhase;
      const dirChanged = signal.direction !== (prev?.direction ?? 'flat');
      if (isNewBar || phaseChanged || dirChanged) {
        void this.persistUpsert(symbol, now2);
      }
    } catch {
      entry.dataMissing = true; // 拉取失败/数据异常：标记缺失，下轮重试
    } finally {
      this.inflight.delete(symbol);
    }
  }

  // ============ 持久化 ============

  private recordFor(symbol: string, now: number) {
    const entry = this.pool.get(symbol);
    const st = this.states.get(symbol);
    const signal = this.lastSignals.get(symbol);
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

  snapshot(now: number): TrendWatchSnapshot {
    const tickers = new Map<string, TrendTickerSnap>(
      this.deps.getTickers().map((t) => [t.symbol, t]),
    );
    const phaseW = (p: string) => (p === 'confirmed' ? 0 : p === 'candidate' ? 1 : 2);
    const rows: TrendWatchRow[] = [];
    for (const [sym, entry] of this.pool) {
      const st = this.states.get(sym);
      const signal = this.lastSignals.get(sym);
      const ctx = this.anomalyCtx.get(sym);
      const ticker = tickers.get(sym);
      const lastBar = entry.lastBarTime;
      const phase = st?.phase ?? 'idle';
      const direction = st?.direction ?? 'flat';
      const conflict =
        direction !== 'flat' &&
        ctx?.dir != null &&
        (direction === 'up') !== (ctx.dir === 'UP');
      rows.push({
        symbol: sym,
        base: baseOf(sym),
        phase,
        direction,
        score: st?.lastScore ?? 0,
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
        phaseW(a.phase) - phaseW(b.phase) ||
        b.score - a.score ||
        a.symbol.localeCompare(b.symbol),
    );
    const stats: TrendWatchStats = {
      poolSize: this.pool.size,
      maxPoolSize: TREND_WATCH.MAX_TREND_SYMBOLS,
      confirmed: rows.filter((r) => r.phase === 'confirmed').length,
      candidate: rows.filter((r) => r.phase === 'candidate').length,
      watching: rows.filter((r) => r.phase === 'idle').length,
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
