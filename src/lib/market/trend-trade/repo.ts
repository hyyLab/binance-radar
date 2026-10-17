// ---------- 趋势自动模拟交易 · 持久化（SQLite，raw SQL） ----------
// 与 trend-watch/repo.ts 同一模式：raw SQL 对新旧 PrismaClient 一致可用（运行中的
// dev server 未重新 generate 也能工作）；表结构与 prisma/schema.prisma 同步。
//
// 幂等设计（任务 §四）：
// - TrendAutoDecision.id = 决策键（`{cycleId}:OPEN` 等），INSERT OR IGNORE 抢占——
//   数据库唯一约束兜底，服务重启/并发请求/定时任务重复执行都不会重复开仓。
// - 持仓趋势关联 TrendTradeMeta（positionId 主键 = PaperPosition.id），重启后
//   loadOpenMetas() 恢复全部持仓关联；启动时 reconcile 修复崩溃窗口（见 auto-trader）。
//
// 写入纪律：只在决策发生/状态变化时写库；不做周期性无条件落库。

import { db } from '@/lib/db';
import type { PrismaClient } from '@prisma/client';

type RawClient = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

export interface TrendAutoConfigRow {
  name: string;
  mode: string; // RUNNING | PAUSED | STOPPED
  initialCapital: number;
  marginRatio: number;
  leverage: number;
  maxPositions: number;
  slippageBps: number;
  peakEquity: number;
}

export interface TrendTradeMetaRow {
  positionId: string;
  trendCycleId: string;
  symbol: string;
  side: string; // LONG | SHORT
  trendPhaseAtOpen: string;
  scoreAtOpen: number;
  featuresAtOpen: string;
  signalAtOpen: string;
  slippageEst: number;
  status: string; // OPEN | CLOSED
  exitReason: string | null;
  exitSignalJson: string | null;
  netPnlWithSlip: number | null;
  openDecisionAt: Date | number | null;
  closedAt: Date | number | null;
}

/** 幂等建表（与 schema.prisma 同步；已存在则跳过，无损） */
export async function ensureTrendTradeSchema(client: RawClient = db): Promise<void> {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TrendAutoConfig" (
      "id"            TEXT    NOT NULL PRIMARY KEY,
      "name"          TEXT    NOT NULL UNIQUE,
      "mode"          TEXT    NOT NULL DEFAULT 'RUNNING',
      "initialCapital" REAL   NOT NULL,
      "marginRatio"   REAL    NOT NULL DEFAULT 0.2,
      "leverage"      REAL    NOT NULL DEFAULT 20,
      "maxPositions"  INTEGER NOT NULL DEFAULT 4,
      "slippageBps"   REAL    NOT NULL DEFAULT 2,
      "peakEquity"    REAL    NOT NULL DEFAULT 0,
      "updatedAt"     DATETIME NOT NULL
    )`);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TrendTradeMeta" (
      "positionId"       TEXT    NOT NULL PRIMARY KEY,
      "trendCycleId"     TEXT    NOT NULL,
      "symbol"           TEXT    NOT NULL,
      "side"             TEXT    NOT NULL,
      "trendPhaseAtOpen" TEXT    NOT NULL,
      "scoreAtOpen"      REAL    NOT NULL DEFAULT 0,
      "featuresAtOpen"   TEXT    NOT NULL DEFAULT '{}',
      "signalAtOpen"     TEXT    NOT NULL DEFAULT '{}',
      "slippageEst"      REAL    NOT NULL DEFAULT 0,
      "status"           TEXT    NOT NULL DEFAULT 'OPEN',
      "exitReason"       TEXT,
      "exitSignalJson"   TEXT,
      "netPnlWithSlip"   REAL,
      "openDecisionAt"   DATETIME,
      "closedAt"         DATETIME,
      "updatedAt"        DATETIME NOT NULL
    )`);
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "TrendTradeMeta_trendCycleId_idx" ON "TrendTradeMeta"("trendCycleId")`,
  );
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "TrendTradeMeta_status_idx" ON "TrendTradeMeta"("status")`,
  );
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TrendAutoDecision" (
      "id"         TEXT   NOT NULL PRIMARY KEY,
      "symbol"     TEXT   NOT NULL,
      "action"     TEXT   NOT NULL,
      "cycleId"    TEXT   NOT NULL,
      "positionId" TEXT,
      "detail"     TEXT   NOT NULL DEFAULT '{}',
      "createdAt"  DATETIME NOT NULL
    )`);
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "TrendAutoDecision_cycleId_idx" ON "TrendAutoDecision"("cycleId")`,
  );
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "TrendAutoDecision_createdAt_idx" ON "TrendAutoDecision"("createdAt" DESC)`,
  );
}

function toMs(v: Date | number | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

export function metaFromRow(row: Record<string, unknown>): TrendTradeMetaRow {
  return {
    positionId: String(row.positionId),
    trendCycleId: String(row.trendCycleId),
    symbol: String(row.symbol),
    side: String(row.side),
    trendPhaseAtOpen: String(row.trendPhaseAtOpen),
    scoreAtOpen: Number(row.scoreAtOpen ?? 0),
    featuresAtOpen: String(row.featuresAtOpen ?? '{}'),
    signalAtOpen: String(row.signalAtOpen ?? '{}'),
    slippageEst: Number(row.slippageEst ?? 0),
    status: String(row.status ?? 'OPEN'),
    exitReason: (row.exitReason as string | null) ?? null,
    exitSignalJson: (row.exitSignalJson as string | null) ?? null,
    netPnlWithSlip: row.netPnlWithSlip != null ? Number(row.netPnlWithSlip) : null,
    openDecisionAt: toMs(row.openDecisionAt as Date | number | null),
    closedAt: toMs(row.closedAt as Date | number | null),
  };
}

export function createTrendTradeRepo(client: RawClient = db) {
  return {
    // ===== 配置 =====
    async loadConfig(name: string): Promise<TrendAutoConfigRow | null> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT name, mode, initialCapital, marginRatio, leverage, maxPositions, slippageBps, peakEquity
         FROM TrendAutoConfig WHERE name = ?`,
        name,
      );
      const r = rows[0];
      return r
        ? {
            name: String(r.name),
            mode: String(r.mode),
            initialCapital: Number(r.initialCapital),
            marginRatio: Number(r.marginRatio),
            leverage: Number(r.leverage),
            maxPositions: Number(r.maxPositions),
            slippageBps: Number(r.slippageBps),
            peakEquity: Number(r.peakEquity ?? 0),
          }
        : null;
    },

    async seedConfig(cfg: TrendAutoConfigRow): Promise<void> {
      const id = `trend-auto:${cfg.name}`;
      await client.$executeRawUnsafe(
        `INSERT INTO TrendAutoConfig
           (id, name, mode, initialCapital, marginRatio, leverage, maxPositions, slippageBps, peakEquity, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
        id,
        cfg.name,
        cfg.mode,
        cfg.initialCapital,
        cfg.marginRatio,
        cfg.leverage,
        cfg.maxPositions,
        cfg.slippageBps,
        cfg.peakEquity,
        new Date(),
      );
    },

    async updateMode(name: string, mode: string): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET mode = ?, updatedAt = ? WHERE name = ?`,
        mode,
        new Date(),
        name,
      );
    },

    /** 更新最大同时持仓数（Task 55：持仓数量界面可选；auto-trader 每 tick 重读配置，即时生效） */
    async updateMaxPositions(name: string, maxPositions: number): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET maxPositions = ?, updatedAt = ? WHERE name = ?`,
        maxPositions,
        new Date(),
        name,
      );
    },

    async updatePeakEquity(name: string, peakEquity: number): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET peakEquity = ?, updatedAt = ? WHERE name = ? AND peakEquity < ?`,
        peakEquity,
        new Date(),
        name,
        peakEquity,
      );
    },

    /** 峰值无条件归零（Task 55-2 重置账户专用；updatePeakEquity 是峰值语义，写入 0 不生效） */
    async resetPeakEquity(name: string): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET peakEquity = 0, updatedAt = ? WHERE name = ?`,
        new Date(),
        name,
      );
    },

    // ===== 幂等决策（数据库唯一约束兜底） =====
    /** INSERT OR IGNORE：返回 true = 本进程抢占成功（首次决策）；false = 已存在（重复信号/重启重放） */
    async claimDecision(input: {
      id: string;
      symbol: string;
      action: string;
      cycleId: string;
      positionId?: string | null;
      detail?: string;
    }): Promise<boolean> {
      const changes = await client.$executeRawUnsafe(
        `INSERT OR IGNORE INTO TrendAutoDecision
           (id, symbol, action, cycleId, positionId, detail, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.symbol,
        input.action,
        input.cycleId,
        input.positionId ?? null,
        input.detail ?? '{}',
        new Date(),
      );
      return changes > 0;
    },

    async hasDecision(id: string): Promise<boolean> {
      const rows = await client.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM TrendAutoDecision WHERE id = ?`,
        id,
      );
      return rows.length > 0;
    },

    async recentDecisions(limit = 50): Promise<Record<string, unknown>[]> {
      return client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT id, symbol, action, cycleId, positionId, detail, createdAt
         FROM TrendAutoDecision ORDER BY createdAt DESC LIMIT ?`,
        limit,
      );
    },

    // ===== 持仓趋势关联 =====
    async upsertMeta(meta: TrendTradeMetaRow): Promise<void> {
      await client.$executeRawUnsafe(
        `INSERT INTO TrendTradeMeta
           (positionId, trendCycleId, symbol, side, trendPhaseAtOpen, scoreAtOpen,
            featuresAtOpen, signalAtOpen, slippageEst, status, exitReason, exitSignalJson,
            netPnlWithSlip, openDecisionAt, closedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(positionId) DO UPDATE SET
           trendCycleId = excluded.trendCycleId,
           symbol = excluded.symbol,
           side = excluded.side,
           trendPhaseAtOpen = excluded.trendPhaseAtOpen,
           scoreAtOpen = excluded.scoreAtOpen,
           featuresAtOpen = excluded.featuresAtOpen,
           signalAtOpen = excluded.signalAtOpen,
           slippageEst = excluded.slippageEst,
           status = excluded.status,
           exitReason = excluded.exitReason,
           exitSignalJson = excluded.exitSignalJson,
           netPnlWithSlip = excluded.netPnlWithSlip,
           openDecisionAt = excluded.openDecisionAt,
           closedAt = excluded.closedAt,
           updatedAt = excluded.updatedAt`,
        meta.positionId,
        meta.trendCycleId,
        meta.symbol,
        meta.side,
        meta.trendPhaseAtOpen,
        meta.scoreAtOpen,
        meta.featuresAtOpen,
        meta.signalAtOpen,
        meta.slippageEst,
        meta.status,
        meta.exitReason,
        meta.exitSignalJson,
        meta.netPnlWithSlip,
        meta.openDecisionAt != null ? new Date(meta.openDecisionAt) : null,
        meta.closedAt != null ? new Date(meta.closedAt) : null,
        new Date(),
      );
    },

    async getMeta(positionId: string): Promise<TrendTradeMetaRow | null> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM TrendTradeMeta WHERE positionId = ?`,
        positionId,
      );
      return rows[0] ? metaFromRow(rows[0]) : null;
    },

    async loadMetasByStatus(status: 'OPEN' | 'CLOSED'): Promise<TrendTradeMetaRow[]> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM TrendTradeMeta WHERE status = ? ORDER BY positionId`,
        status,
      );
      return rows.map(metaFromRow);
    },

    /** 最近一次该 symbol 的平仓时刻（「先平后开」独立性判定用） */
    async lastCloseAt(symbol: string): Promise<number | null> {
      const rows = await client.$queryRawUnsafe<{ closedAt: Date | number | null }[]>(
        `SELECT closedAt FROM TrendTradeMeta
         WHERE symbol = ? AND status = 'CLOSED' AND closedAt IS NOT NULL
         ORDER BY closedAt DESC LIMIT 1`,
        symbol,
      );
      return rows[0] ? toMs(rows[0].closedAt) : null;
    },
  };
}

export type TrendTradeRepo = ReturnType<typeof createTrendTradeRepo>;

/** 生产默认 repo */
export const trendTradeRepo: TrendTradeRepo = createTrendTradeRepo();
