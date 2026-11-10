// ---------- PA 整合 · 异步 AI 分析队列（任务书 §7.2） ----------
// 交易主循环绝不等待 AI：本模块是独立 worker 池（并发默认 2、可配置），扫描器只投递
// 任务；分析完成后在回调里做协同判断 → Stage2 → Validator → 待入场单创建。
// 纪律：
// - 幂等：{symbol}:{barTime5m}:{promptVersion} 已分析过 → 跳过（重试/刷新/重扫不重复）；
// - 同一 symbol 同时只允许一个在队任务；
// - 超时/异常/解析失败 → PaAnalysis 留痕 status=AI_FAILED，候选回 WAITING_CONFIRMATION；
//   绝不降级为 UTE-only 开仓（红线 7）；
// - 新的已收盘 5m K 线到来才允许重新分析（barTime5m 幂等键天然保证）；
// - 冷却：同 symbol 分析间隔 ≥ analysisCooldownMs（除非 barTime5m 变化）。

import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { buildPaMarketSnapshot } from './data-adapter';
import { runStage1, runStage2 } from './diagnosis-service';
import { coordinate } from './coordination-engine';
import { validatePlan } from './trade-plan-validator';
import { computeFeatures } from './indicators';
import { PA_PROMPT_VERSION } from './config';
import { ensurePaSchema, paRepo } from './repo';
import type { PaActionConfig, CoordinationResult, PaRawPlan, PaTradePlan } from './types';
import { PaActionTrader } from './pa-trader';

export interface PaAnalysisArtifacts {
  symbol: string;
  analysisId: string;
  coordination: CoordinationResult;
  plan: PaTradePlan | null;
  rejectedReason: string | null;
}

export class PaAnalysisQueue {
  private queue: { symbol: string; direction: 'LONG' | 'SHORT'; uteCycleId: string | null; enqueuedAt: number }[] = [];
  private inQueue = new Set<string>();
  private running = 0;
  private analysisSymbols = new Set<string>(); // PA_ANALYZING 状态展示
  private lastError: string | null = null;
  private processed = 0;
  private failed = 0;

  constructor(
    private readonly trader: PaActionTrader,
    private readonly getConfig: () => Promise<PaActionConfig>,
  ) {}

  stats() {
    return {
      queued: this.queue.length,
      running: this.running,
      analyzing: [...this.analysisSymbols],
      lastError: this.lastError,
      processed: this.processed,
      failed: this.failed,
    };
  }

  /** 是否已在队列/执行中（含冷却判断的外部入口先查这里） */
  isBusy(symbol: string): boolean {
    return this.inQueue.has(symbol) || this.analysisSymbols.has(symbol);
  }

  /** 投递分析任务（幂等：同 symbol 在队即忽略） */
  enqueue(symbol: string, direction: 'LONG' | 'SHORT', uteCycleId: string | null): boolean {
    if (this.inQueue.has(symbol) || this.analysisSymbols.has(symbol)) return false;
    if (this.queue.length >= 64) return false; // 队列上限（防请求风暴）
    this.inQueue.add(symbol);
    this.queue.push({ symbol, direction, uteCycleId, enqueuedAt: Date.now() });
    return true;
  }

  /** worker 泵（scheduler 定时调用；按并发上限拉起任务） */
  async pump(): Promise<void> {
    const cfg = await this.getConfig();
    if (cfg.aiEnabled !== 1) return;
    while (this.running < Math.max(1, cfg.aiConcurrency) && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.inQueue.delete(task.symbol);
      this.running++;
      this.analysisSymbols.add(task.symbol);
      void this.run(task).finally(() => {
        this.running--;
        this.analysisSymbols.delete(task.symbol);
      });
    }
  }

  private async run(task: { symbol: string; direction: 'LONG' | 'SHORT'; uteCycleId: string | null; enqueuedAt: number }): Promise<void> {
    const { symbol, direction } = task;
    const cfg = await this.getConfig();
    const engine = getEnhancedEngine();
    try {
      await ensurePaSchema();
      const now = Date.now();

      // ① 行情快照（只读缓存；无 1m 缓存则限频回填一次）
      const snap = await buildPaMarketSnapshot(symbol, { triggerBackfill: true });
      if (!snap.ok || snap.barTime5m == null || snap.barTime15m == null) {
        await this.recordFailure(symbol, direction, snap.barTime5m ?? 0, snap.barTime15m ?? 0, 'STALE', snap.waitReason ?? '行情数据不可用', 0);
        await paRepo.updateCandidate(symbol, { status: 'ELIGIBLE', lastReason: `WAIT：${snap.waitReason ?? '数据不足'}` });
        return;
      }

      // ② 幂等键（同 symbol + 同 5m bar + 同 prompt 版本不重复分析）
      const analysisId = `${symbol}:${snap.barTime5m}:${PA_PROMPT_VERSION}`;
      if (await paRepo.hasAnalysis(analysisId)) {
        await paRepo.updateCandidate(symbol, { status: 'WAITING_CONFIRMATION', lastReason: '本根 5m 已分析过（幂等跳过）' });
        return;
      }

      // ③ UTE 快照（协同输入；分析期间信号变化以分析时刻为准，留档）
      const sig = engine.trendWatch.latestSignals().find((s) => s.symbol === symbol) ?? null;
      if (!sig || !(sig.phase === 'CONFIRMED_UP' || sig.phase === 'CONFIRMED_DOWN') || !sig.dataFresh) {
        await this.recordFailure(symbol, direction, snap.barTime5m, snap.barTime15m, 'STALE', `UTE 不再确认（phase=${sig?.phase ?? '-'}）`, 0);
        await paRepo.updateCandidate(symbol, { status: 'ELIGIBLE', lastReason: 'UTE 相位失效，回到候选池' });
        return;
      }

      // ④ Stage1（5m 主诊断 + 15m 背景）
      const meta = { symbol, timeframe: cfg.mainTimeframe };
      let stage1, stage2, coordination: CoordinationResult, plan: PaRawPlan | null = null;
      const t0 = Date.now();
      try {
        stage1 = await runStage1(meta, snap.bars5m, snap.bars15m);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.recordFailure(symbol, direction, snap.barTime5m, snap.barTime15m, 'AI_FAILED', `Stage1 失败：${msg}`, Date.now() - t0);
        await paRepo.updateCandidate(symbol, { status: 'WAITING_CONFIRMATION', lastReason: `AI 失败（Stage1）：${msg}` });
        this.failed++;
        return;
      }

      // ⑤ 协同判断（先于 Stage2：只有 ALIGNED 才进入 Stage2——任务书 §5.2/§六）
      coordination = coordinate({
        ute: {
          direction: sig.direction,
          phase: sig.phase,
          trendCycleId: sig.trendCycleId,
          score: sig.score,
          signalTime: sig.changedAt,
          sourceSignal: sig,
        },
        pa: {
          diagnosis: stage1.diagnosis,
          htf: stage1.htf,
          analysisTime: now,
          barTime5m: snap.barTime5m,
        },
        mark: snap.mark,
      });

      let planFinal: PaTradePlan | null = null;
      let validatorChecks: unknown = null;
      let rawPlanJson: string | null = null;
      let invalidReason: string | null = null;

      if (coordination.decision === 'ALLOW') {
        try {
          stage2 = await runStage2(meta, snap.bars5m, stage1.diagnosisJson, stage1.diagnosis);
          rawPlanJson = JSON.stringify(stage2.plan ?? { order_type: '不下单', downgraded: stage2.downgraded });
          plan = stage2.plan;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await this.saveAnalysisRecord(symbol, direction, { barTime5m: snap.barTime5m as number, barTime15m: snap.barTime15m as number }, sig, stage1, coordination, null, null, null, 'AI_FAILED', `Stage2 失败：${msg}`, Date.now() - t0);
          await paRepo.updateCandidate(symbol, { status: 'WAITING_CONFIRMATION', lastReason: `AI 失败（Stage2）：${msg}`, lastAnalysisId: analysisId, lastAnalysisAt: now });
          this.failed++;
          return;
        }

        if (plan && plan.entryPrice != null) {
          // ⑥ Validator（程序化校验，禁自动加宽止损）
          const fb = computeFeatures(snap.bars5m);
          const last5m = fb.features.length ? fb.features[fb.features.length - 1] : null;
          const v = validatePlan(plan, {
            last5m: last5m ? { open: last5m.o, high: last5m.h, low: last5m.l, close: last5m.c, ts: last5m.ts } : null,
            mark: snap.mark,
            tickSize: snap.tickSize,
            minRiskReward: cfg.minRiskReward,
            maxEntryDeviationPct: cfg.entryMaxDeviationPct,
            barTime5m: snap.barTime5m,
            now,
            uteDirection: sig.direction,
            coordinationState: coordination.state,
            analysisAgeMs: Date.now() - t0,
            maxAnalysisAgeMs: 10 * 60_000,
          });
          validatorChecks = v.checks;
          if (v.plan) {
            planFinal = { ...v.plan, promptVersion: PA_PROMPT_VERSION, analysisId };
          } else {
            invalidReason = v.checks.filter((c) => !c.passed).map((c) => `${c.label}：${c.detail}`).join('；');
          }
        } else if (plan && plan.entryPrice == null) {
          invalidReason = 'AI 判定不下单（有效结论，等待后续 K 线）';
        }
      } else if (coordination.decision === 'REJECT') {
        invalidReason = `协同拒绝：${coordination.reason}`;
      } else {
        invalidReason = `协同等待：${coordination.reason}`;
      }

      // ⑦ 落库 + 候选状态推进（快照已过空检查，提取非空局部量供结构化传参）
      const snapTimes = { barTime5m: snap.barTime5m as number, barTime15m: snap.barTime15m as number };
      await this.saveAnalysisRecord(symbol, direction, snapTimes, sig, stage1, coordination, rawPlanJson, planFinal, validatorChecks, planFinal ? 'OK' : 'INVALID_PLAN', invalidReason, Date.now() - t0);
      await paRepo.updateCandidate(symbol, {
        status: planFinal ? 'PLAN_READY' : coordination.decision === 'REJECT' ? 'REJECTED' : 'WAITING_CONFIRMATION',
        coordinationState: coordination.state,
        coordinationDecision: coordination.decision,
        lastAnalysisId: analysisId,
        lastAnalysisAt: now,
        lastReason: planFinal ? `计划就绪：${planFinal.orderType} entry=${planFinal.entryPrice} RR=${planFinal.rewardRisk.toFixed(2)}` : (invalidReason ?? ''),
      });

      // ⑧ 计划就绪 → 待入场单（独立账户执行层；容量/冷却/幂等在 createPendingOrder 内守卫）
      if (planFinal) {
        const metas = await paRepo.loadPositionMetas('OPEN');
        const r = await this.trader.createPendingOrder(planFinal, cfg, metas);
        if (!r.ok) {
          await paRepo.updateCandidate(symbol, { lastReason: `计划就绪但未建单：${r.reason}` });
        }
      }

      // ⑨ 结构性冲突 → 若该 symbol 有同向 PA 持仓（更晚开仓的分析覆盖），按配置提前退出
      if (coordination.decision === 'REJECT') {
        const openMetas = await paRepo.loadPositionMetas('OPEN');
        const pos = openMetas.find((m) => m.symbol === symbol && m.side === direction);
        if (pos) {
          await this.trader.closeRemaining(pos, 'PA_STRUCTURE_INVALID', snap.mark, `结构性冲突：${coordination.reason}`);
        }
      }

      this.processed++;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.failed++;
      await paRepo.updateCandidate(symbol, { status: 'WAITING_CONFIRMATION', lastReason: `分析异常：${this.lastError}` }).catch(() => {});
    }
  }

  private async recordFailure(
    symbol: string, direction: string, bar5m: number, bar15m: number,
    status: string, error: string, latency: number,
  ): Promise<void> {
    await paRepo.saveAnalysis({
      id: `${symbol}:${bar5m}:${PA_PROMPT_VERSION}`,
      symbol,
      direction: direction as 'LONG' | 'SHORT',
      barTime5m: bar5m,
      barTime15m: bar15m,
      promptVersion: PA_PROMPT_VERSION,
      uteSnapshotJson: '{}',
      diagnosisJson: '{}',
      htfJson: '{}',
      coordinationState: 'UNCERTAIN',
      coordinationDecision: 'WAIT',
      coordinationJson: '{}',
      rawPlanJson: null,
      planJson: null,
      validatorJson: null,
      status,
      error,
      aiLatencyMs: latency,
      createdAt: Date.now(),
    });
    this.failed++;
  }

  /** 完整分析记录落库（含 UTE 快照/诊断/协同/计划/校验全链路留痕） */
  private async saveAnalysisRecord(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    snap: { barTime5m: number; barTime15m: number },
    sig: { trendCycleId: string | null; score: number; phase: string },
    stage1: { diagnosisJson: string; htfJson: string | null },
    coordination: CoordinationResult,
    rawPlanJson: string | null,
    planFinal: PaTradePlan | null,
    validatorChecks: unknown,
    status: string,
    error: string | null,
    latency: number,
  ): Promise<void> {
    await paRepo.saveAnalysis({
      id: `${symbol}:${snap.barTime5m}:${PA_PROMPT_VERSION}`,
      symbol,
      direction,
      barTime5m: snap.barTime5m,
      barTime15m: snap.barTime15m,
      promptVersion: PA_PROMPT_VERSION,
      uteSnapshotJson: JSON.stringify({ trendCycleId: sig.trendCycleId, score: sig.score, phase: sig.phase }),
      diagnosisJson: stage1.diagnosisJson,
      htfJson: stage1.htfJson ?? '{}',
      coordinationState: coordination.state,
      coordinationDecision: coordination.decision,
      coordinationJson: JSON.stringify(coordination),
      rawPlanJson,
      planJson: planFinal ? JSON.stringify(planFinal) : null,
      validatorJson: validatorChecks ? JSON.stringify(validatorChecks) : null,
      status,
      error,
      aiLatencyMs: latency,
      createdAt: Date.now(),
    });
  }
}
