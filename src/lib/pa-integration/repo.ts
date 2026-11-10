// ---------- PA 整合 · 数据访问层（幂等增量建表 + 读写） ----------
// 建表纪律（任务书红线 12）：
// - ensurePaSchema 与 ensureTrendTradeSchema 同模式：CREATE TABLE IF NOT EXISTS +
//   PRAGMA table_info 补列——绝不 DROP/RENAME 现有表，绝不触碰 default / trend-auto-v1
//   账户数据与现有全部表；
// - boot 与每个 API 路由入口调用（幂等，重复调用零开销——进程内 once 缓存）。

import { db } from '@/lib/db';
import type { PaActionConfig, PaAnalysisRecord, PaPendingOrderRow, PaPositionMetaRow } from './types';
import { PA_STRATEGY_ID } from './config';

type RawClient = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
};

let schemaReady: Promise<void> | null = null;

export async function ensurePaSchema(client: RawClient = db as unknown as RawClient): Promise<void> {
  if (!schemaReady) {
    schemaReady = doEnsure(client).catch((e) => {
      schemaReady = null; // 失败允许重试
      throw e;
    });
  }
  return schemaReady;
}

async function doEnsure(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "PaActionConfig" (
       id TEXT PRIMARY KEY NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 0,
       aiEnabled INTEGER NOT NULL DEFAULT 1,
       mainTimeframe TEXT NOT NULL DEFAULT '5m',
       htfTimeframe TEXT NOT NULL DEFAULT '15m',
       riskPerTradePct REAL NOT NULL DEFAULT 0.5,
       maxPositions INTEGER NOT NULL DEFAULT 3,
       maxTotalRiskPct REAL NOT NULL DEFAULT 2,
       leverage INTEGER NOT NULL DEFAULT 10,
       leverageCap INTEGER NOT NULL DEFAULT 20,
       tp1CloseRatio REAL NOT NULL DEFAULT 0.5,
       breakevenAfterTp1 INTEGER NOT NULL DEFAULT 0,
       orderExpiryMs INTEGER NOT NULL DEFAULT 1800000,
       entryMaxDeviationPct REAL NOT NULL DEFAULT 0.3,
       stopCooldownMs INTEGER NOT NULL DEFAULT 1800000,
       analysisCooldownMs INTEGER NOT NULL DEFAULT 900000,
       aiConcurrency INTEGER NOT NULL DEFAULT 2,
       minRiskReward REAL NOT NULL DEFAULT 1.0,
       feeRate REAL NOT NULL DEFAULT 0.0002,
       slippageBps INTEGER NOT NULL DEFAULT 2,
       updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "PaCandidate" (
       symbol TEXT PRIMARY KEY NOT NULL,
       status TEXT NOT NULL DEFAULT 'DISCOVERED',
       sourcePoolsJson TEXT NOT NULL DEFAULT '[]',
       uteDirection TEXT,
       utePhase TEXT,
       uteScore REAL,
       trendCycleId TEXT,
       coordinationState TEXT,
       coordinationDecision TEXT,
       lastAnalysisId TEXT,
       lastAnalysisAt INTEGER,
       lastReason TEXT,
       pendingOrderId TEXT,
       filterCount INTEGER NOT NULL DEFAULT 0,
       createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updatedAt DATETIME
     )`,
  );
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "PaAnalysis" (
       id TEXT PRIMARY KEY NOT NULL,
       symbol TEXT NOT NULL,
       direction TEXT NOT NULL,
       barTime5m INTEGER NOT NULL,
       barTime15m INTEGER NOT NULL,
       promptVersion TEXT NOT NULL,
       uteSnapshotJson TEXT NOT NULL DEFAULT '{}',
       diagnosisJson TEXT NOT NULL DEFAULT '{}',
       htfJson TEXT NOT NULL DEFAULT '{}',
       coordinationState TEXT NOT NULL DEFAULT 'UNCERTAIN',
       coordinationDecision TEXT NOT NULL DEFAULT 'WAIT',
       coordinationJson TEXT NOT NULL DEFAULT '{}',
       rawPlanJson TEXT,
       planJson TEXT,
       validatorJson TEXT,
       status TEXT NOT NULL,
       error TEXT,
       aiLatencyMs INTEGER NOT NULL DEFAULT 0,
       createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  await client.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaAnalysis_symbol_createdAt_idx" ON "PaAnalysis"("symbol", "createdAt" DESC)`);
  await client.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaAnalysis_status_idx" ON "PaAnalysis"("status")`);
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "PaPendingOrder" (
       id TEXT PRIMARY KEY NOT NULL,
       symbol TEXT NOT NULL,
       direction TEXT NOT NULL,
       kind TEXT NOT NULL,
       triggerPrice REAL NOT NULL,
       maxDeviationPct REAL NOT NULL,
       stopLoss REAL NOT NULL,
       takeProfit1 REAL NOT NULL,
       takeProfit2 REAL NOT NULL,
       qty REAL NOT NULL,
       leverage INTEGER NOT NULL,
       margin REAL NOT NULL,
       status TEXT NOT NULL DEFAULT 'ACTIVE',
       cancelReason TEXT,
       positionId TEXT,
       planId TEXT NOT NULL,
       analysisId TEXT NOT NULL,
       barTime5m INTEGER NOT NULL,
       createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       triggeredAt DATETIME,
       updatedAt DATETIME
     )`,
  );
  await client.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaPendingOrder_status_idx" ON "PaPendingOrder"("status")`);
  await client.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaPendingOrder_symbol_idx" ON "PaPendingOrder"("symbol")`);
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "PaPositionMeta" (
       positionId TEXT PRIMARY KEY NOT NULL,
       symbol TEXT NOT NULL,
       side TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'OPEN',
       planId TEXT NOT NULL,
       analysisId TEXT NOT NULL,
       trendCycleId TEXT NOT NULL,
       stopLoss REAL NOT NULL,
       takeProfit1 REAL NOT NULL,
       takeProfit2 REAL NOT NULL,
       initialQty REAL NOT NULL,
       remainingQty REAL NOT NULL,
       tp1Done INTEGER NOT NULL DEFAULT 0,
       tp2Done INTEGER NOT NULL DEFAULT 0,
       breakevenMoved INTEGER NOT NULL DEFAULT 0,
       realizedPnl REAL NOT NULL DEFAULT 0,
       exitReason TEXT,
       openedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       closedAt DATETIME,
       updatedAt DATETIME
     )`,
  );
  await client.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaPositionMeta_status_idx" ON "PaPositionMeta"("status")`);
  await client.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaPositionMeta_symbol_idx" ON "PaPositionMeta"("symbol")`);
}

// ============ 候选 ============

export interface PaCandidateRow {
  symbol: string;
  status: string;
  sourcePoolsJson: string;
  uteDirection: string | null;
  utePhase: string | null;
  uteScore: number | null;
  trendCycleId: string | null;
  coordinationState: string | null;
  coordinationDecision: string | null;
  lastAnalysisId: string | null;
  lastAnalysisAt: number | null;
  lastReason: string | null;
  pendingOrderId: string | null;
  filterCount: number;
  createdAt: Date;
  updatedAt: Date | null;
}

export const paRepo = {
  /** upsert 候选（保留已有 coordination/analysis 字段——只覆盖扫描侧字段） */
  async upsertCandidate(input: {
    symbol: string;
    status: string;
    sourcePoolsJson: string;
    uteDirection?: string | null;
    utePhase?: string | null;
    uteScore?: number | null;
    trendCycleId?: string | null;
    lastReason?: string | null;
  }): Promise<void> {
    await db.paCandidate.upsert({
      where: { symbol: input.symbol },
      create: {
        symbol: input.symbol,
        status: input.status,
        sourcePoolsJson: input.sourcePoolsJson,
        uteDirection: input.uteDirection ?? null,
        utePhase: input.utePhase ?? null,
        uteScore: input.uteScore ?? null,
        trendCycleId: input.trendCycleId ?? null,
        lastReason: input.lastReason ?? null,
      },
      update: {
        status: input.status,
        sourcePoolsJson: input.sourcePoolsJson,
        uteDirection: input.uteDirection ?? null,
        utePhase: input.utePhase ?? null,
        uteScore: input.uteScore ?? null,
        trendCycleId: input.trendCycleId ?? null,
        lastReason: input.lastReason ?? null,
      },
    });
  },

  async updateCandidate(symbol: string, patch: Partial<PaCandidateRow>): Promise<void> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.sourcePoolsJson !== undefined) data.sourcePoolsJson = patch.sourcePoolsJson;
    if (patch.uteDirection !== undefined) data.uteDirection = patch.uteDirection;
    if (patch.utePhase !== undefined) data.utePhase = patch.utePhase;
    if (patch.uteScore !== undefined) data.uteScore = patch.uteScore;
    if (patch.trendCycleId !== undefined) data.trendCycleId = patch.trendCycleId;
    if (patch.coordinationState !== undefined) data.coordinationState = patch.coordinationState;
    if (patch.coordinationDecision !== undefined) data.coordinationDecision = patch.coordinationDecision;
    if (patch.lastAnalysisId !== undefined) data.lastAnalysisId = patch.lastAnalysisId;
    if (patch.lastAnalysisAt !== undefined) data.lastAnalysisAt = patch.lastAnalysisAt ? new Date(patch.lastAnalysisAt) : null;
    if (patch.lastReason !== undefined) data.lastReason = patch.lastReason;
    if (patch.pendingOrderId !== undefined) data.pendingOrderId = patch.pendingOrderId;
    if (patch.filterCount !== undefined) data.filterCount = patch.filterCount;
    await db.paCandidate.update({ where: { symbol }, data });
  },

  async loadCandidates(status?: string): Promise<PaCandidateRow[]> {
    if (status) return db.paCandidate.findMany({ where: { status }, orderBy: { updatedAt: 'desc' } });
    return db.paCandidate.findMany({ orderBy: { updatedAt: 'desc' } });
  },

  async loadCandidate(symbol: string): Promise<PaCandidateRow | null> {
    return db.paCandidate.findUnique({ where: { symbol } });
  },

  /** 冷却查询：最近一次分析时间 */
  async lastAnalysisAt(symbol: string): Promise<number | null> {
    const rows = await db.$queryRawUnsafe<{ lastAnalysisAt: number | null }[]>(
      `SELECT MAX(CASE WHEN createdAt IS NULL THEN NULL ELSE CAST(strftime('%s', createdAt) AS INTEGER) * 1000 END) AS lastAnalysisAt
       FROM PaAnalysis WHERE symbol = ?`,
      symbol,
    );
    return rows[0]?.lastAnalysisAt ?? null;
  },

  // ============ 分析记录 ============

  async saveAnalysis(rec: PaAnalysisRecord): Promise<void> {
    await db.paAnalysis.upsert({
      where: { id: rec.id },
      create: {
        id: rec.id,
        symbol: rec.symbol,
        direction: rec.direction,
        barTime5m: rec.barTime5m,
        barTime15m: rec.barTime15m,
        promptVersion: rec.promptVersion,
        uteSnapshotJson: rec.uteSnapshotJson,
        diagnosisJson: rec.diagnosisJson,
        htfJson: rec.htfJson,
        coordinationState: rec.coordinationState,
        coordinationDecision: rec.coordinationDecision,
        coordinationJson: rec.coordinationJson,
        rawPlanJson: rec.rawPlanJson,
        planJson: rec.planJson,
        validatorJson: rec.validatorJson,
        status: rec.status,
        error: rec.error,
        aiLatencyMs: rec.aiLatencyMs,
      },
      update: {
        coordinationState: rec.coordinationState,
        coordinationDecision: rec.coordinationDecision,
        coordinationJson: rec.coordinationJson,
        rawPlanJson: rec.rawPlanJson,
        planJson: rec.planJson,
        validatorJson: rec.validatorJson,
        status: rec.status,
        error: rec.error,
        aiLatencyMs: rec.aiLatencyMs,
      },
    });
  },

  async getAnalysis(id: string) {
    return db.paAnalysis.findUnique({ where: { id } });
  },

  async listAnalyses(opts: { symbol?: string; limit: number }): Promise<unknown[]> {
    return db.paAnalysis.findMany({
      where: opts.symbol ? { symbol: opts.symbol } : undefined,
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
    });
  },

  /** 幂等键是否已分析过（同 symbol + 同 5m bar + 同 prompt 版本） */
  async hasAnalysis(id: string): Promise<boolean> {
    const row = await db.paAnalysis.findUnique({ where: { id }, select: { id: true } });
    return row != null;
  },

  // ============ 待入场单 ============

  async savePendingOrder(row: PaPendingOrderRow): Promise<boolean> {
    try {
      await db.paPendingOrder.create({
        data: {
          id: row.id,
          symbol: row.symbol,
          direction: row.direction,
          kind: row.kind,
          triggerPrice: row.triggerPrice,
          maxDeviationPct: row.maxDeviationPct,
          stopLoss: row.stopLoss,
          takeProfit1: row.takeProfit1,
          takeProfit2: row.takeProfit2,
          qty: row.qty,
          leverage: row.leverage,
          margin: row.margin,
          status: row.status,
          cancelReason: row.cancelReason,
          positionId: row.positionId,
          planId: row.planId,
          analysisId: row.analysisId,
          barTime5m: row.barTime5m,
          triggeredAt: row.triggeredAt ? new Date(row.triggeredAt) : null,
        },
      });
      return true;
    } catch {
      return false; // 唯一约束冲突 = 已存在（幂等兜底）
    }
  },

  async updatePendingOrder(id: string, patch: Partial<PaPendingOrderRow>): Promise<void> {
    const data: Record<string, unknown> = { ...patch };
    if (patch.triggeredAt != null) data.triggeredAt = new Date(patch.triggeredAt);
    delete data.id;
    delete data.createdAt;
    await db.paPendingOrder.update({ where: { id }, data });
  },

  async getPendingOrder(id: string): Promise<PaPendingOrderRow | null> {
    const r = await db.paPendingOrder.findUnique({ where: { id } });
    return r ? pendingToRow(r) : null;
  },

  async loadPendingOrders(status?: string): Promise<PaPendingOrderRow[]> {
    const rows = status
      ? await db.paPendingOrder.findMany({ where: { status }, orderBy: { createdAt: 'desc' } })
      : await db.paPendingOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(pendingToRow);
  },

  async hasActivePendingForSymbol(symbol: string): Promise<boolean> {
    const n = await db.paPendingOrder.count({ where: { symbol, status: 'ACTIVE' } });
    return n > 0;
  },

  // ============ 持仓元数据 ============

  async savePositionMeta(row: PaPositionMetaRow): Promise<void> {
    await db.paPositionMeta.upsert({
      where: { positionId: row.positionId },
      create: {
        positionId: row.positionId,
        symbol: row.symbol,
        side: row.side,
        status: row.status,
        planId: row.planId,
        analysisId: row.analysisId,
        trendCycleId: row.trendCycleId,
        stopLoss: row.stopLoss,
        takeProfit1: row.takeProfit1,
        takeProfit2: row.takeProfit2,
        initialQty: row.initialQty,
        remainingQty: row.remainingQty,
        tp1Done: row.tp1Done,
        tp2Done: row.tp2Done,
        breakevenMoved: row.breakevenMoved,
        realizedPnl: row.realizedPnl,
        exitReason: row.exitReason,
        openedAt: new Date(row.openedAt),
        closedAt: row.closedAt ? new Date(row.closedAt) : null,
      },
      update: {
        status: row.status,
        stopLoss: row.stopLoss,
        tp1Done: row.tp1Done,
        tp2Done: row.tp2Done,
        breakevenMoved: row.breakevenMoved,
        realizedPnl: row.realizedPnl,
        remainingQty: row.remainingQty,
        exitReason: row.exitReason,
        closedAt: row.closedAt ? new Date(row.closedAt) : null,
      },
    });
  },

  async getPositionMeta(positionId: string): Promise<PaPositionMetaRow | null> {
    const r = await db.paPositionMeta.findUnique({ where: { positionId } });
    return r ? metaToRow(r) : null;
  },

  async loadPositionMetas(status?: string): Promise<PaPositionMetaRow[]> {
    const rows = status
      ? await db.paPositionMeta.findMany({ where: { status }, orderBy: { openedAt: 'desc' } })
      : await db.paPositionMeta.findMany({ orderBy: { openedAt: 'desc' }, take: 200 });
    return rows.map(metaToRow);
  },

  /** PA 账户 id（paperEngineFor 修复后按账户名隔离） */
  async paAccountId(): Promise<string> {
    const acc = await db.paperAccount.findUnique({ where: { name: PA_STRATEGY_ID_ACCOUNT } });
    if (!acc) throw new Error('PA 模拟账户未初始化');
    return acc.id;
  },

  /** 最近一次 PA 平仓时刻（止损冷却用） */
  async lastCloseAt(symbol: string): Promise<number | null> {
    const rows = await db.$queryRawUnsafe<{ lastCloseAt: number | null }[]>(
      `SELECT MAX(CAST(strftime('%s', closedAt) AS INTEGER) * 1000) AS lastCloseAt
       FROM PaPositionMeta WHERE symbol = ? AND closedAt IS NOT NULL`,
      symbol,
    );
    return rows[0]?.lastCloseAt ?? null;
  },
};

/** PA 账户名（config 循环依赖规避：此处直接用常量） */
const PA_STRATEGY_ID_ACCOUNT = 'pa-auto-v1';

 
function pendingToRow(r: any): PaPendingOrderRow {
  return {
    id: r.id,
    symbol: r.symbol,
    direction: r.direction,
    kind: r.kind,
    triggerPrice: r.triggerPrice,
    maxDeviationPct: r.maxDeviationPct,
    stopLoss: r.stopLoss,
    takeProfit1: r.takeProfit1,
    takeProfit2: r.takeProfit2,
    qty: r.qty,
    leverage: r.leverage,
    margin: r.margin,
    status: r.status,
    cancelReason: r.cancelReason,
    positionId: r.positionId,
    planId: r.planId,
    analysisId: r.analysisId,
    barTime5m: r.barTime5m,
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt),
    triggeredAt: r.triggeredAt ? (r.triggeredAt instanceof Date ? r.triggeredAt.getTime() : Number(r.triggeredAt)) : null,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.getTime() : Number(r.updatedAt ?? Date.now()),
  };
}

 
function metaToRow(r: any): PaPositionMetaRow {
  return {
    positionId: r.positionId,
    symbol: r.symbol,
    side: r.side,
    status: r.status,
    planId: r.planId,
    analysisId: r.analysisId,
    trendCycleId: r.trendCycleId,
    stopLoss: r.stopLoss,
    takeProfit1: r.takeProfit1,
    takeProfit2: r.takeProfit2,
    initialQty: r.initialQty,
    remainingQty: r.remainingQty,
    tp1Done: r.tp1Done,
    tp2Done: r.tp2Done,
    breakevenMoved: r.breakevenMoved,
    realizedPnl: r.realizedPnl,
    exitReason: r.exitReason,
    openedAt: r.openedAt instanceof Date ? r.openedAt.getTime() : Number(r.openedAt),
    closedAt: r.closedAt ? (r.closedAt instanceof Date ? r.closedAt.getTime() : Number(r.closedAt)) : null,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.getTime() : Number(r.updatedAt ?? Date.now()),
  };
}

/** 配置行 → PaActionConfig（db 客户端直接读，避免 config↔repo 循环） */
export async function readPaConfigRow(): Promise<PaActionConfig | null> {
  const row = await db.paActionConfig.findUnique({ where: { id: PA_STRATEGY_ID } });
  if (!row) return null;
  return {
    enabled: row.enabled,
    aiEnabled: row.aiEnabled,
    mainTimeframe: row.mainTimeframe,
    htfTimeframe: row.htfTimeframe,
    riskPerTradePct: row.riskPerTradePct,
    maxPositions: row.maxPositions,
    maxTotalRiskPct: row.maxTotalRiskPct,
    leverage: row.leverage,
    leverageCap: row.leverageCap,
    tp1CloseRatio: row.tp1CloseRatio,
    breakevenAfterTp1: row.breakevenAfterTp1,
    orderExpiryMs: row.orderExpiryMs,
    entryMaxDeviationPct: row.entryMaxDeviationPct,
    stopCooldownMs: row.stopCooldownMs,
    analysisCooldownMs: row.analysisCooldownMs,
    aiConcurrency: row.aiConcurrency,
    minRiskReward: row.minRiskReward,
    feeRate: row.feeRate,
    slippageBps: row.slippageBps,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.now(),
  };
}
