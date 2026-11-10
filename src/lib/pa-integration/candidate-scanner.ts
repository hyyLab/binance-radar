// ---------- PA 整合 · 全池候选扫描器（任务书 §3.3） ----------
// 流程：所有业务池 → 合并去重（保留来源）→ 基础数据检查 → UTE 趋势检查 →
// 持仓/待入场/冷却过滤 → PA 分析候选（投递异步队列）。
// 纪律：
// - 不要求对所有币种每轮调 AI：只有满足基础条件的币种进入深度分析；
// - 无有效 UTE 方向的币种保留为观察对象（DISCOVERED），不生成交易计划；
// - 每个候选记录进入/过滤原因（lastReason），扫描统计留档；
// - 冷却：距上次分析 < analysisCooldownMs 且回调未出现新 5m 收盘 → 不重复分析；
// - 快速规则层不调 AI、不做网络请求（行情检查用内存缓存）。

import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { readPoolUniverse } from './pool-universe';
import { liveFuturesMark } from './market-snapshot';
import { ensurePaSchema, paRepo } from './repo';
import type { PaActionConfig } from './types';
import { PA_STRATEGY_ID } from './config';
import type { PaAnalysisQueue } from './analysis-queue';

export interface ScanStats {
  ts: number;
  poolsReachable: number;
  poolsError: number;
  totalRaw: number;
  unique: number;
  uteValid: number;
  waitingAnalysis: number;
  analyzing: number;
  enqueued: number;
  skippedCooldown: number;
  skippedPosition: number;
  skippedData: number;
}

const g = globalThis as typeof globalThis & {
  __paLastScanStats?: ScanStats;
};

export function lastScanStats(): ScanStats | null {
  return g.__paLastScanStats ?? null;
}

/** 单轮全池扫描（scheduler 每 60s 调用；幂等、可重入安全——重入直接跳过本轮） */
export async function scanOnce(
  cfg: PaActionConfig,
  queue: PaAnalysisQueue,
  trader: { overview(): Promise<{ openPositions: number }> },
): Promise<ScanStats> {
  const stats: ScanStats = {
    ts: Date.now(), poolsReachable: 0, poolsError: 0, totalRaw: 0, unique: 0,
    uteValid: 0, waitingAnalysis: 0, analyzing: 0, enqueued: 0,
    skippedCooldown: 0, skippedPosition: 0, skippedData: 0,
  };
  try {
    await ensurePaSchema();
    const universe = await readPoolUniverse();
    stats.totalRaw = universe.totalRaw;
    stats.unique = universe.entries.length;
    stats.poolsReachable = universe.pools.filter((p) => !p.error).length;
    stats.poolsError = universe.pools.filter((p) => p.error).length;

    // UTE 信号索引（唯一趋势来源）
    const engine = getEnhancedEngine();
    const signals = engine.trendWatch.latestSignals();
    const bySymbol = new Map(signals.map((s) => [s.symbol, s]));

    // 持仓/待入场/冷却
    const openMetas = await paRepo.loadPositionMetas('OPEN');
    const openSymbols = new Set(openMetas.map((m) => m.symbol));
    const activePendings = await paRepo.loadPendingOrders('ACTIVE');
    const pendingSymbols = new Set(activePendings.map((p) => p.symbol));
    const openCount = await trader.overview().then((o) => o.openPositions).catch(() => openSymbols.size);

    for (const entry of universe.entries) {
      const symbol = entry.symbol;
      const poolsJson = JSON.stringify(entry.sourcePools.map((p) => ({ poolId: p.poolId, poolName: p.poolName, status: p.status })));
      const sig = bySymbol.get(symbol) ?? null;
      const uteDir = sig && (sig.phase === 'CONFIRMED_UP' || sig.phase === 'CONFIRMED_DOWN') ? sig.direction : null;
      if (uteDir) stats.uteValid++;

      // ① 已有 PA 持仓/待入场单 → 不再分析（防重复开仓）
      if (openSymbols.has(symbol) || pendingSymbols.has(symbol)) {
        stats.skippedPosition++;
        await paRepo.upsertCandidate({
          symbol,
          status: openSymbols.has(symbol) ? 'PLAN_READY' : 'ELIGIBLE',
          sourcePoolsJson: poolsJson,
          uteDirection: uteDir,
          utePhase: sig?.phase ?? null,
          uteScore: sig?.score ?? null,
          trendCycleId: sig?.trendCycleId ?? null,
          lastReason: openSymbols.has(symbol) ? '已有 PA 持仓（跟踪管理中）' : '已有待入场单（等待触发）',
        });
        continue;
      }

      // ② 无有效 UTE 方向 → 观察对象（不分析、不开仓）
      if (!uteDir || !sig || !sig.dataFresh) {
        const reason = !sig
          ? '无 UTE 信号（观察对象）'
          : !sig.dataFresh
            ? `UTE 数据不可用（${sig.dataUnavailableReason ?? '未知'}）`
            : `UTE 相位=${sig.phase}（未确认，观察中）`;
        await paRepo.upsertCandidate({
          symbol,
          status: 'DISCOVERED',
          sourcePoolsJson: poolsJson,
          uteDirection: sig?.direction ?? null,
          utePhase: sig?.phase ?? null,
          uteScore: sig?.score ?? null,
          trendCycleId: sig?.trendCycleId ?? null,
          lastReason: reason,
        });
        continue;
      }

      // ③ 行情可用性快速检查（内存缓存，不触发网络）
      const mark = liveFuturesMark(symbol);
      if (!(mark > 0)) {
        stats.skippedData++;
        await paRepo.upsertCandidate({
          symbol, status: 'DISCOVERED', sourcePoolsJson: poolsJson,
          uteDirection: uteDir, utePhase: sig.phase, uteScore: sig.score, trendCycleId: sig.trendCycleId,
          lastReason: '标记价不可用（合约行情未就绪）',
        });
        continue;
      }

      // ④ AI 队列忙 → 等待
      if (queue.isBusy(symbol)) {
        stats.analyzing++;
        await paRepo.upsertCandidate({
          symbol, status: 'PA_ANALYZING', sourcePoolsJson: poolsJson,
          uteDirection: uteDir, utePhase: sig.phase, uteScore: sig.score, trendCycleId: sig.trendCycleId,
          lastReason: 'PA 分析中（异步队列）',
        });
        continue;
      }

      // ⑤ 冷却：距上次分析不足 analysisCooldownMs → 跳过（同 5m bar 的幂等在队列内兜底）
      const lastAt = await paRepo.lastAnalysisAt(symbol);
      if (lastAt != null && Date.now() - lastAt < cfg.analysisCooldownMs) {
        stats.skippedCooldown++;
        await paRepo.upsertCandidate({
          symbol, status: 'WAITING_CONFIRMATION', sourcePoolsJson: poolsJson,
          uteDirection: uteDir, utePhase: sig.phase, uteScore: sig.score, trendCycleId: sig.trendCycleId,
          lastReason: `分析冷却中（距上次 ${Math.ceil((Date.now() - lastAt) / 1000)}s）`,
        });
        continue;
      }

      // ⑥ 容量守卫：已达最大持仓数不再投递新分析（省 AI 配额）
      if (openCount >= cfg.maxPositions) {
        stats.skippedPosition++;
        await paRepo.upsertCandidate({
          symbol, status: 'ELIGIBLE', sourcePoolsJson: poolsJson,
          uteDirection: uteDir, utePhase: sig.phase, uteScore: sig.score, trendCycleId: sig.trendCycleId,
          lastReason: `已达最大持仓数 ${cfg.maxPositions}（暂停新分析）`,
        });
        continue;
      }

      // ⑦ 通过快速筛选 → 投递 PA 分析
      const direction: 'LONG' | 'SHORT' = uteDir === 'up' ? 'LONG' : 'SHORT';
      const enqueued = queue.enqueue(symbol, direction, sig.trendCycleId);
      if (enqueued) {
        stats.enqueued++;
        stats.waitingAnalysis++;
        await paRepo.upsertCandidate({
          symbol, status: 'PA_ANALYZING', sourcePoolsJson: poolsJson,
          uteDirection: uteDir, utePhase: sig.phase, uteScore: sig.score, trendCycleId: sig.trendCycleId,
          lastReason: `已投递 PA 分析（UTE ${uteDir === 'up' ? '多头' : '空头'} 确认趋势）`,
        });
      } else {
        stats.waitingAnalysis++;
        await paRepo.upsertCandidate({
          symbol, status: 'ELIGIBLE', sourcePoolsJson: poolsJson,
          uteDirection: uteDir, utePhase: sig.phase, uteScore: sig.score, trendCycleId: sig.trendCycleId,
          lastReason: '分析队列已满/在队（等待）',
        });
      }
    }

    // 过期候选清理：超过 24h 未更新且无持仓/待入场 → EXPIRED
    const staleCutoff = Date.now() - 24 * 3_600_000;
    const all = await paRepo.loadCandidates();
    for (const c of all) {
      const updatedAt = c.updatedAt instanceof Date ? c.updatedAt.getTime() : Number(c.updatedAt ?? 0);
      if (
        updatedAt > 0 && updatedAt < staleCutoff &&
        c.status !== 'PLAN_READY' && !openSymbols.has(c.symbol) && !pendingSymbols.has(c.symbol)
      ) {
        await paRepo.updateCandidate(c.symbol, { status: 'EXPIRED', lastReason: '24h 未活跃（退出扫描视野）' });
      }
    }

    g.__paLastScanStats = stats;
    return stats;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[pa-action] 全池扫描失败：${msg}`);
    g.__paLastScanStats = { ...stats, skippedData: stats.skippedData };
    return stats;
  }
}

export const PA_STRATEGY = PA_STRATEGY_ID;
