// ---------- AutoPaperTrader：趋势自动模拟交易服务（Task 54 §3/§四） ----------
// 消费 TrendWatchService 输出的统一趋势信号（UnifiedTrendSignal，单一趋势来源——
// 本服务绝不另行计算趋势方向），按固定规则开仓/持仓/平仓；纯模拟，不接入真实下单。
//
// 规则（用户定版）：
// - 独立账户 trend-auto-v1（PaperAccount.name 隔离；手动 default 盘完全不受影响）
// - 开仓：确认趋势（CONFIRMED_UP/DOWN）才开；Task 55 sizing = 可用余额 ÷ 剩余仓位数
//   （持仓数量界面可选，更换时自动平仓原有持仓；分子预留开仓手续费）；
//   杠杆固定 20x；同一趋势周期只允许一笔（决策键幂等）
// - 不设固定止盈止损：趋势确认结束（ENDED）平仓；反向趋势确认平仓（先平后开，
//   新方向须由晚于平仓时刻的已收盘 K 线再次确认）；保留强平机制（独立巡检任务）
// - 数据不可用（DATA_UNAVAILABLE/过期）：不新开仓、不伪装趋势结束、继续按标记价
//   管理强平；暂停模式：只停新开仓，继续退出管理与强平巡检
// - 成本口径：开/平仓手续费按 PaperEngine Taker 0.05% 双边；滑点按可配基点估算，
//   成交记录展示；统计主口径 = 含滑点净盈亏（更保守，不省略成本）
// - 成交假设：以决策时刻标记价成交（非信号 K 线收盘价），绝不使用未来行情
//
// 生命周期：绑定 EnhancedEngine（boot 拉起 / stop 停表）；单例由引擎单例保证；
// 重启后从 DB 恢复持仓关联（TrendTradeMeta）并 reconcile 崩溃窗口。

import { db } from '@/lib/db';
import { PaperError, PaperEngine, paperEngineFor } from '../paper';
import { TAKER_FEE } from '../futures';
import type { UnifiedTrendSignal } from '../trend-watch/signal';
import { TREND_TRADE, type TrendAutoMode, type TrendExitReason } from './config';
import {
  createTrendTradeRepo,
  ensureTrendTradeSchema,
  type TrendAutoConfigRow,
  type TrendTradeMetaRow,
  type TrendTradeRepo,
} from './repo';

export interface AutoTraderDeps {
  /** 统一趋势信号（trendWatch.latestSignals——唯一趋势来源） */
  getSignals(): UnifiedTrendSignal[];
  /** 标记价（合约多源供价） */
  markPrice(symbol: string): number;
}

interface SkipRecord {
  t: number;
  symbol: string;
  reason: string;
  cycleId?: string;
}

function floor2(v: number): number {
  return Math.floor((v + 1e-9) * 100) / 100;
}

function isTransientOpenError(e: unknown): boolean {
  if (!(e instanceof PaperError)) return false;
  // 行情未就绪/未知交易对 = 暂时性（下轮重试）；保证金/上限类 = 永久跳过
  return e.message.includes('行情') || e.message.includes('未知交易对');
}

export class AutoPaperTrader {
  private readonly deps: AutoTraderDeps;
  private readonly repo: TrendTradeRepo;
  private readonly engine: PaperEngine;

  private started = false;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 引擎启动时刻（engine.stats 摘要用；0 = 未启动） */
  startedAt = 0;
  private lastTickAt = 0;
  private lastError: string | null = null;

  /** 跳过记录（内存审计；接口可见最近 50 条） */
  private skips: SkipRecord[] = [];
  opens = 0;
  closes = 0;

  constructor(deps: AutoTraderDeps, opts?: { repo?: TrendTradeRepo; engine?: PaperEngine; noTimer?: boolean }) {
    this.deps = deps;
    this.repo = opts?.repo ?? createTrendTradeRepo();
    this.engine = opts?.engine ?? paperEngineFor(TREND_TRADE.ACCOUNT_NAME);
    this.noTimer = opts?.noTimer ?? false;
  }

  private readonly noTimer: boolean;

  // ============ 生命周期 ============

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
      this.starting = null;
    });
    await Promise.race([this.starting, new Promise((r) => setTimeout(r, 6000))]);
  }

  private async boot(): Promise<void> {
    // 1) 建表（幂等）+ 播种配置 + 独立账户初始化（balance = 可配初始资金）
    await ensureTrendTradeSchema();
    const seeded = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    if (!seeded) {
      await this.repo.seedConfig({
        name: TREND_TRADE.ACCOUNT_NAME,
        mode: 'RUNNING',
        initialCapital: TREND_TRADE.INITIAL_CAPITAL,
        marginRatio: TREND_TRADE.MARGIN_RATIO,
        leverage: TREND_TRADE.LEVERAGE,
        maxPositions: TREND_TRADE.MAX_POSITIONS,
        slippageBps: TREND_TRADE.SLIPPAGE_BPS,
        peakEquity: 0,
      });
    }
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (!acc) {
      await db.paperAccount.create({
        data: { name: TREND_TRADE.ACCOUNT_NAME, balance: TREND_TRADE.INITIAL_CAPITAL },
      });
    }
    // 2) reconcile：修复崩溃窗口（开仓成功但 meta 未写 / 平仓成功但 meta 未关）
    await this.reconcile();
    // 3) 主循环（独立持续风险检查任务：无页面访问也照常巡检强平与管理持仓）
    if (!this.noTimer) this.timer = setInterval(() => void this.tick(), TREND_TRADE.SCAN_MS);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 崩溃窗口修复（任务 §七：服务重启后必须恢复持仓关联信息）：
   * a) 自动账户 OPEN 持仓缺 TrendTradeMeta → 从最近一条已抢占未绑定的 OPEN 决策恢复
   *    cycleId；找不到则标 ORPHAN 周期（保守：只受强平/人工管理，不参与趋势退出判定）。
   * b) meta OPEN 但 PaperPosition 已 CLOSED/LIQUIDATED → 补写平仓终态。
   */
  private async reconcile(): Promise<void> {
    try {
      const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
      if (!acc) return;
      const openPositions = await db.paperPosition.findMany({
        where: { accountId: acc.id, status: 'OPEN' },
      });
      for (const p of openPositions) {
        const meta = await this.repo.getMeta(p.id);
        if (!meta) {
          const claimed = await db.$queryRawUnsafe<{ cycleId: string; createdAt: Date }[]>(
            `SELECT cycleId, createdAt FROM TrendAutoDecision
             WHERE symbol = ? AND action = 'OPEN' AND positionId IS NULL
             ORDER BY createdAt DESC LIMIT 1`,
            p.symbol,
          );
          const cycleId = claimed[0]?.cycleId ?? `ORPHAN:${p.symbol}:${p.openedAt.getTime()}`;
          await this.repo.upsertMeta({
            positionId: p.id,
            trendCycleId: cycleId,
            symbol: p.symbol,
            side: p.side,
            trendPhaseAtOpen: 'CONFIRMED_RESTORED',
            scoreAtOpen: 0,
            featuresAtOpen: JSON.stringify({ restored: true, recoveredAt: Date.now() }),
            signalAtOpen: '{}',
            slippageEst: p.qty * p.entryPrice * (TREND_TRADE.SLIPPAGE_BPS / 10_000),
            status: 'OPEN',
            exitReason: null,
            exitSignalJson: null,
            netPnlWithSlip: null,
            openDecisionAt: claimed[0]?.createdAt ?? p.openedAt,
            closedAt: null,
          });
        }
      }
      // meta OPEN 但仓位已终态 → 补写
      const openMetas = await this.repo.loadMetasByStatus('OPEN');
      for (const m of openMetas) {
        const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
        if (!pos) {
          await this.repo.upsertMeta({ ...m, status: 'CLOSED', exitReason: 'MANUAL', closedAt: new Date() });
          continue;
        }
        if (pos.status === 'LIQUIDATED') {
          await this.finalizeLiquidated(m, pos.margin, pos.pnl ?? -pos.margin);
        } else if (pos.status === 'CLOSED') {
          await this.repo.upsertMeta({
            ...m,
            status: 'CLOSED',
            exitReason: 'MANUAL',
            netPnlWithSlip: (pos.pnl ?? 0) - m.slippageEst,
            closedAt: pos.closedAt ?? new Date(),
          });
        }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] reconcile 失败：', this.lastError);
    }
  }

  // ============ 主循环 ============

  /** 单步主循环：public 以便测试/回放驱动（生产由 SCAN_MS 定时器调用） */
  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const now = Date.now();
      this.lastTickAt = now;
      const cfg = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
      if (!cfg) return;
      const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
      if (!acc) return;
      const accId = acc.id;

      // ① 持续风险巡检（任何模式都执行——强平不因暂停/数据不可用而缺席）
      await this.engine.liquidationCheck(accId);
      await this.finalizeNewLiquidations();

      // ② 退出管理（暂停模式也执行：趋势结束/反向确认照常离场）
      const signals = this.deps.getSignals();
      const bySymbol = new Map(signals.map((s) => [s.symbol, s]));
      await this.manageExits(bySymbol);

      // ③ 权益峰值（回撤基准；任何模式都更新）
      const eq = await this.accountEquity(accId);
      if (eq.equity > cfg.peakEquity) {
        await this.repo.updatePeakEquity(TREND_TRADE.ACCOUNT_NAME, eq.equity);
      }

      // ④ 开仓（仅 RUNNING 且数据新鲜；暂停/停止只停新开仓）
      if (cfg.mode === 'RUNNING') {
        await this.manageEntries(cfg, signals, eq);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] tick 失败：', this.lastError);
    }
  }

  // ============ 退出管理 ============

  private async manageExits(bySymbol: Map<string, UnifiedTrendSignal>): Promise<void> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    for (const meta of openMetas) {
      const signal = bySymbol.get(meta.symbol);
      if (!signal) continue; // 信号缺失（标的退池/未评估）：不误平仓，仅强平/人工管理
      if (signal.phase === 'ENDED' && signal.trendCycleId === meta.trendCycleId) {
        await this.closePosition(meta, 'TREND_ENDED', signal);
      } else if (
        (signal.phase === 'CONFIRMED_UP' || signal.phase === 'CONFIRMED_DOWN') &&
        signal.trendCycleId !== meta.trendCycleId &&
        (meta.side === 'LONG' ? signal.direction === 'down' : signal.direction === 'up')
      ) {
        await this.closePosition(meta, 'REVERSE_CONFIRMED', signal);
      }
    }
  }

  /** 平仓（幂等护栏 = 仓位状态本身；决策行事后审计记录） */
  private async closePosition(
    meta: TrendTradeMetaRow,
    reason: TrendExitReason,
    signal: UnifiedTrendSignal | null,
  ): Promise<void> {
    try {
      const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (!pos || pos.status !== 'OPEN') {
        // 已终态（并发/重启窗口）：补写 meta 终态
        await this.repo.upsertMeta({
          ...meta,
          status: 'CLOSED',
          exitReason: pos?.status === 'LIQUIDATED' ? 'LIQUIDATED' : reason,
          netPnlWithSlip: (pos?.pnl ?? 0) - meta.slippageEst,
          closedAt: pos?.closedAt ?? new Date(),
        });
        return;
      }
      const r = await this.engine.close(meta.positionId);
      const mark = r.price;
      const closeSlip = mark * pos.qty * (TREND_TRADE.SLIPPAGE_BPS / 10_000);
      const netWithSlip = r.pnl - meta.slippageEst - closeSlip;
      await this.repo.upsertMeta({
        ...meta,
        status: 'CLOSED',
        exitReason: reason,
        exitSignalJson: signal ? JSON.stringify(signal) : null,
        netPnlWithSlip: netWithSlip,
        closedAt: new Date(),
      });
      await this.repo.claimDecision({
        id: `${meta.trendCycleId}:CLOSE`,
        symbol: meta.symbol,
        action: reason === 'REVERSE_CONFIRMED' ? 'REVERSE_CLOSE' : 'CLOSE',
        cycleId: meta.trendCycleId,
        positionId: meta.positionId,
        detail: JSON.stringify({
          reason,
          exitPrice: r.price,
          netPnl: r.pnl,
          netPnlWithSlip: netWithSlip,
          endReason: signal?.endReason ?? null,
        }),
      });
      this.closes++;
    } catch (e) {
      // 平仓暂时性失败（行情不可用等）：下一轮重试（决策行未写，不烧掉本周期）
      if (!(e instanceof PaperError)) {
        this.pushSkip(meta.symbol, `平仓异常：${e instanceof Error ? e.message : e}`, meta.trendCycleId);
      }
    }
  }

  /** 强平巡检后的 meta 终态补写（强平是执行结果，如实记录、不伪装模型止损） */
  private async finalizeNewLiquidations(): Promise<void> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    for (const m of openMetas) {
      const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
      if (pos && pos.status === 'LIQUIDATED') {
        await this.finalizeLiquidated(m, pos.margin, pos.pnl ?? -pos.margin);
      }
    }
  }

  private async finalizeLiquidated(m: TrendTradeMetaRow, margin: number, pnl: number): Promise<void> {
    await this.repo.upsertMeta({
      ...m,
      status: 'CLOSED',
      exitReason: 'LIQUIDATED',
      netPnlWithSlip: pnl - m.slippageEst,
      closedAt: new Date(),
    });
    await this.repo.claimDecision({
      id: `${m.trendCycleId}:CLOSE`,
      symbol: m.symbol,
      action: 'CLOSE',
      cycleId: m.trendCycleId,
      positionId: m.positionId,
      detail: JSON.stringify({ reason: 'LIQUIDATED', netPnlWithSlip: pnl - m.slippageEst, margin }),
    });
    this.closes++;
  }

  // ============ 开仓决策 ============

  private async manageEntries(
    cfg: TrendAutoConfigRow,
    signals: UnifiedTrendSignal[],
    eq: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number },
  ): Promise<void> {
    for (const signal of signals) {
      if (!(TREND_TRADE.CONFIRMED_PHASES as readonly string[]).includes(signal.phase)) continue; // 候选趋势不开仓
      if (!signal.dataFresh) {
        this.pushSkip(signal.symbol, '数据不可用/过期（不开新仓）', signal.trendCycleId ?? undefined);
        continue;
      }
      const cycleId = signal.trendCycleId;
      if (!cycleId) continue;
      const side = signal.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';

      // 幂等守卫 1：同 symbol 已有 OPEN 关联持仓（防御；正常由周期决策键保证）
      const dup = await db.paperPosition.findFirst({
        where: { accountId: await this.autoAccountId(), symbol: signal.symbol, status: 'OPEN' },
      });
      if (dup) continue;

      // 容量守卫（跳过不烧周期：仓位释放后同一确认趋势仍可开）
      if (eq.openCount >= cfg.maxPositions) {
        this.recordSkip(signal.symbol, `已达最大持仓数 ${cfg.maxPositions}`, cycleId);
        continue;
      }

      // 「先平后开」独立性：确认评估包含的已收盘 K 线必须晚于该 symbol 上一笔平仓
      // （同一根 K 线不既触发平仓又触发反向开仓；首笔无平仓记录直接放行）
      if (TREND_TRADE.REVERSE_INDEPENDENT_BARS) {
        const lastClose = await this.repo.lastCloseAt(signal.symbol);
        if (
          lastClose != null &&
          signal.lastBarTime != null &&
          signal.lastBarTime + 60_000 <= lastClose
        ) {
          this.recordSkip(signal.symbol, '等待平仓后下一根已收盘 K 线确认（先平后开）', cycleId);
          continue;
        }
      }

      // 仓位测算（Task 55 用户定版）：每仓目标保证金由「持仓数量」决定——
      // 可用余额按剩余仓位数平均分配；分子预留开仓手续费（margin×杠杆×taker），
      // 否则最后一仓因 margin+fee>可用余额永远开不出。分母用剩余仓位数：
      // 已占用的仓位不再重复分钱，每次开仓天然填满一个槽位。
      // （开仓时点余额即「当时权益中可动用的现金」；已实现盈亏会随余额滚动计入，
      //  浮动盈亏不影响未开槽位的分配——保守口径）
      const remainingSlots = Math.max(1, cfg.maxPositions - eq.openCount);
      const targetMargin = floor2(eq.balance / remainingSlots / (1 + cfg.leverage * TAKER_FEE));
      if (targetMargin < TREND_TRADE.MIN_MARGIN) {
        await this.recordSkipDb(signal.symbol, cycleId, `权益不足：目标保证金 ${targetMargin} < ${TREND_TRADE.MIN_MARGIN}`);
        continue;
      }
      const fee = targetMargin * cfg.leverage * TAKER_FEE;
      if (targetMargin + fee > eq.balance) {
        await this.recordSkipDb(
          signal.symbol,
          cycleId,
          `可用余额不足：需 ${targetMargin.toFixed(2)} + 手续费 ${fee.toFixed(2)}，可用 ${eq.balance.toFixed(2)}`,
        );
        continue;
      }

      // 幂等守卫 2（数据库唯一约束兜底）：抢占 `{cycleId}:OPEN` 决策——
      // 重启重放/并发请求/定时任务重复执行都会在此被拦截
      const claimed = await this.repo.claimDecision({
        id: `${cycleId}:OPEN`,
        symbol: signal.symbol,
        action: 'OPEN',
        cycleId,
        detail: JSON.stringify(this.openDetail(signal, targetMargin, cfg)),
      });
      if (!claimed) continue; // 本趋势周期已决策过

      try {
        const pos = await this.engine.open({
          symbol: signal.symbol,
          side,
          leverage: cfg.leverage,
          margin: targetMargin,
        });
        const slippageEst = targetMargin * cfg.leverage * (cfg.slippageBps / 10_000);
        await this.repo.upsertMeta({
          positionId: pos.id,
          trendCycleId: cycleId,
          symbol: signal.symbol,
          side,
          trendPhaseAtOpen: signal.phase,
          scoreAtOpen: signal.score,
          featuresAtOpen: JSON.stringify({
            vol: signal.features,
            htf5m: signal.htf5m,
            htf15m: signal.htf15m,
            htfAgree: signal.htfAgree,
            strength: signal.strength,
            anomaly: signal.anomaly,
            conflict: signal.conflict,
          }),
          signalAtOpen: JSON.stringify(signal),
          slippageEst,
          status: 'OPEN',
          exitReason: null,
          exitSignalJson: null,
          netPnlWithSlip: null,
          openDecisionAt: new Date(),
          closedAt: null,
        });
        await this.attachPosition(`${cycleId}:OPEN`, pos.id);
        this.opens++;
        eq.openCount += 1;
        eq.marginUsed += targetMargin;
        eq.balance -= targetMargin + fee;
      } catch (e) {
        if (isTransientOpenError(e)) {
          // 行情暂时不可用：释放决策（下轮同周期可重试）
          await this.releaseDecision(`${cycleId}:OPEN`);
          this.pushSkip(signal.symbol, `开仓暂时失败（将重试）：${e instanceof Error ? e.message : e}`, cycleId);
        } else {
          // 永久跳过（保证金/上限类）：决策保留防重入，原因已记录
          this.pushSkip(signal.symbol, `开仓跳过：${e instanceof Error ? e.message : e}`, cycleId);
        }
      }
    }
  }

  private openDetail(signal: UnifiedTrendSignal, margin: number, cfg: TrendAutoConfigRow) {
    return {
      phase: signal.phase,
      direction: signal.direction,
      score: signal.score,
      strength: signal.strength,
      confirmCount: signal.confirmCount,
      trendStartedAt: signal.trendStartedAt,
      lastBarTime: signal.lastBarTime,
      margin,
      leverage: cfg.leverage,
      /** Task 55：sizing = 可用余额 ÷ 剩余仓位数（由持仓数量决定，平均分配） */
      positionSlots: cfg.maxPositions,
      marginBasis: 'balance/remainingSlots',
      volRegime: signal.features.volRegime,
      atrPct: signal.features.atrPct,
      efficiencyRatio: signal.features.efficiencyRatio,
      htfAgree: signal.htfAgree,
    };
  }

  // ============ 账户/统计 ============

  private autoAccountIdCache: string | null = null;
  private async autoAccountId(): Promise<string> {
    if (this.autoAccountIdCache) return this.autoAccountIdCache;
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (!acc) throw new Error('趋势自动账户未初始化');
    this.autoAccountIdCache = acc.id;
    return acc.id;
  }

  private async accountEquity(accId: string): Promise<{
    balance: number;
    marginUsed: number;
    unrealized: number;
    equity: number;
    openCount: number;
  }> {
    const acc = await db.paperAccount.findUnique({ where: { id: accId } });
    const open = await db.paperPosition.findMany({ where: { accountId: accId, status: 'OPEN' } });
    let marginUsed = 0;
    let unrealized = 0;
    for (const p of open) {
      const mark = this.deps.markPrice(p.symbol);
      const m = mark > 0 ? mark : p.entryPrice;
      marginUsed += p.margin;
      unrealized += (m - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
    }
    const balance = acc?.balance ?? 0;
    return {
      balance,
      marginUsed,
      unrealized,
      equity: balance + marginUsed + unrealized,
      openCount: open.length,
    };
  }

  private pushSkip(symbol: string, reason: string, cycleId?: string): void {
    this.skips.unshift({ t: Date.now(), symbol, reason, cycleId });
    if (this.skips.length > 200) this.skips.length = 200;
  }

  /** 内存审计（容量/独立性等轻量跳过） */
  private recordSkip(symbol: string, reason: string, cycleId: string): void {
    this.pushSkip(symbol, reason, cycleId);
  }

  /** DB 审计（余额/权益类硬性跳过：`{cycleId}:SKIP` 决策行，不阻断后续重试） */
  private async recordSkipDb(symbol: string, cycleId: string, reason: string): Promise<void> {
    this.pushSkip(symbol, reason, cycleId);
    try {
      await this.repo.claimDecision({
        id: `${cycleId}:SKIP`,
        symbol,
        action: 'SKIP',
        cycleId,
        detail: JSON.stringify({ reason, t: Date.now() }),
      });
    } catch {
      // 审计失败不影响决策
    }
  }

  private async releaseDecision(id: string): Promise<void> {
    try {
      await db.$executeRawUnsafe(`DELETE FROM TrendAutoDecision WHERE id = ? AND positionId IS NULL`, id);
    } catch {
      // 释放失败保守处理：该周期不再开仓（幂等优先于重试）
    }
  }

  private async attachPosition(decisionId: string, positionId: string): Promise<void> {
    try {
      await db.$executeRawUnsafe(
        `UPDATE TrendAutoDecision SET positionId = ? WHERE id = ?`,
        positionId,
        decisionId,
      );
    } catch {
      // 绑定失败不影响交易（meta 已建立关联）
    }
  }

  // ============ 控制操作（任务 §5.3：开启/暂停/恢复/全部平仓语义分离） ============

  async pause(): Promise<void> {
    await this.repo.updateMode(TREND_TRADE.ACCOUNT_NAME, 'PAUSED');
  }

  async resume(): Promise<void> {
    await this.repo.updateMode(TREND_TRADE.ACCOUNT_NAME, 'RUNNING');
  }

  async closeOne(positionId: string): Promise<{ ok: boolean; message: string }> {
    const meta = await this.repo.getMeta(positionId);
    if (!meta || meta.status !== 'OPEN') return { ok: false, message: '持仓不存在或已平仓' };
    const signal = this.deps.getSignals().find((s) => s.symbol === meta.symbol) ?? null;
    await this.closePosition(meta, 'MANUAL', signal);
    return { ok: true, message: '已提交平仓' };
  }

  async closeAllManual(): Promise<{ closed: number; skipped: number; totalPnlWithSlip: number }> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    const signals = this.deps.getSignals();
    let closed = 0;
    let skipped = 0;
    let total = 0;
    for (const meta of openMetas) {
      const signal = signals.find((s) => s.symbol === meta.symbol) ?? null;
      const before = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (!before || before.status !== 'OPEN') {
        skipped++;
        continue;
      }
      await this.closePosition(meta, 'MANUAL', signal);
      const after = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (after && after.status !== 'OPEN') {
        closed++;
        total += after.pnl ?? 0;
      } else {
        skipped++;
      }
    }
    return { closed, skipped, totalPnlWithSlip: total };
  }

  mode(): Promise<TrendAutoMode | null> {
    return this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME).then((c) => (c?.mode as TrendAutoMode) ?? null);
  }

  // ============ 对外查询（/api/trend-trading 用） ============

  /** 标记价（合约多源供价；外部路由展示持仓用） */
  markPriceOf(symbol: string): number {
    return this.deps.markPrice(symbol);
  }

  /** 最近一次主循环时间（ms；0 = 尚未运行） */
  get lastTick(): number {
    return this.lastTickAt;
  }

  /** 最近一次主循环错误（null = 正常） */
  get lastErr(): string | null {
    return this.lastError;
  }

  /** 最近跳过记录（审计：为什么没开仓/为什么跳过） */
  recentSkips(limit = 50): SkipRecord[] {
    return this.skips.slice(0, limit);
  }
}
