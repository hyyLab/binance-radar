// ---------- 趋势自动模拟交易 · 持久化（SQLite，raw SQL） ----------
// 与 trend-watch/repo.ts 同一模式：raw SQL 对新旧 PrismaClient 一致可用（运行中的
// dev server 未重新 generate 也能工作）；表结构与 prisma/schema.prisma 同步。
//
// 幂等设计（任务 §四 / Task 56 §八）：
// - TrendAutoDecision.id = 决策键（`{cycleId}:OPEN` 等），INSERT OR IGNORE 抢占——
//   数据库唯一约束兜底，服务重启/并发请求/定时任务重复执行都不会重复开仓。
// - TrendPendingEntry.cycleId 主键——待入场记录每周期至多一条，重启后从 DB 恢复。
// - 持仓趋势关联 TrendTradeMeta（positionId 主键 = PaperPosition.id），重启后
//   loadOpenMetas() 恢复全部持仓关联；启动时 reconcile 修复崩溃窗口（见 auto-trader）。
// - Task 56：TrendTradeMeta 扩展列（MFE/MAE/开仓快照/结束证据）由 ensureTrendTradeSchema
//   按 PRAGMA 幂等补列（运行中服务免 prisma generate，旧库无损升级）。
//
// 写入纪律：只在决策发生/状态变化时写库；MFE/MAE 随主循环按可用标记价增量更新（非未来数据）。

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
  /** Task 57：当前使用的交易策略（registry 注册 id；切换即清场换算法） */
  strategyId?: string;
  /** Task 57-c：策略参数覆盖（JSON map：{ [strategyId]: { KEY: value } }；NULL = 全用代码默认） */
  strategyParamsJson?: string | null;
  /** Task 57-c：待入场「新收盘 K 线二次确认」开关（1 = 开默认 / 0 = 关→达标当根直接开仓） */
  waitBarConfirm?: number;
  /** Task 57-c：同币种平仓后冷却 ms（NULL = 用 TREND_TRADE.COOLDOWN_MS 默认） */
  cooldownMs?: number | null;
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
  // ===== Task 56 扩展列（P3 §七：开仓快照 / 持仓结果采集） =====
  /** 开仓时 1m 效率比（入场质量门槛快照） */
  entryEr?: number | null;
  /** 开仓时 5m/15m 高周期方向（up/down/flat） */
  htf5mDir?: string | null;
  htf15mDir?: string | null;
  /** 开仓时高周期门控状态（ALIGNED/NEUTRAL/OPPOSED/INVALID） */
  htfGate?: string | null;
  /** 开仓名义仓位（保证金 × 杠杆） */
  entryNotional?: number | null;
  /** 开仓依据的已收盘 1m K 线开盘时间（结束证据必须晚于此 bar，§2.3） */
  entryBarTime?: number | null;
  /** 持仓期间最大有利浮盈（占保证金 %；按可用标记价增量更新，绝不用未来数据） */
  mfe?: number | null;
  /** 持仓期间最大不利浮亏（占保证金 %，≤0 口径） */
  mae?: number | null;
  /** MFE 出现时刻（ms） */
  mfeAt?: number | null;
  /** MFE 之后当前回撤幅度（百分点 = mfe - 当前浮盈占比） */
  mfeDrawdown?: number | null;
  /** 首次结束迹象（END_PENDING）时刻（ms；从迹象到确认/平仓耗时统计用） */
  firstEndSignAt?: number | null;
  /** 模型细分结束原因（DECAY / STRUCTURE_INVALIDATION / CONFIRMED_REVERSAL） */
  exitEndReason?: string | null;
  /** 平仓时结束证据根数 */
  exitEvidenceBars?: number | null;
  /** 平仓名义仓位 */
  closeNotional?: number | null;
  /** Task 57：开仓轮次（同 trendCycleId 第几轮开仓；1 = 首次，2 = 走弱后走强再入场） */
  entryRound?: number | null;
}

export interface TrendPendingEntryRow {
  cycleId: string; // 主键：每趋势周期至多一条待入场记录
  symbol: string;
  side: string; // LONG | SHORT
  /** 首次确认时依据的已收盘 K 线开盘时间（转换条件：出现更新的已收盘 K 线，§5.3） */
  firstBarTime: number;
  firstSeenAt: number;
  snapshotJson: string; // 首次确认时的信号快照（取消/转换审计用）
  status: string; // ACTIVE | CONVERTED | CANCELED
  cancelReason: string | null;
  openPositionId: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}

/**
 * 毫秒时间戳列类型迁移（Task 57 线上修复）：早期 raw SQL 建表用 INTEGER 声明，
 * Prisma 对超出 int32 的毫秒值（~1.79e12）绑定 INTEGER 列报
 * "Conversion failed: Value ... does not fit in an INT column"——按官方提示把
 * INTEGER 声明迁为 BIGINT（SQLite 重建表 + 拷贝 + 改名；幂等：仅当列仍为 INTEGER 时执行）。
 * 旧数据按位置整行拷贝，无损；测试库（prisma db push 生成 BIGINT）自动跳过。
 */
async function migrateIntToBigint(client: RawClient): Promise<void> {
  const plans: { table: string; ddl: string; cols: string[]; indexes: string[] }[] = [
    {
      table: 'TrendPendingEntry',
      cols: ['firstBarTime', 'firstSeenAt'],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "TrendPendingEntry_status_idx" ON "TrendPendingEntry"("status")`,
        `CREATE INDEX IF NOT EXISTS "TrendPendingEntry_symbol_idx" ON "TrendPendingEntry"("symbol")`,
      ],
      ddl: `
    CREATE TABLE "TrendPendingEntry__mig" (
      "cycleId"       TEXT    NOT NULL PRIMARY KEY,
      "symbol"        TEXT    NOT NULL,
      "side"          TEXT    NOT NULL,
      "firstBarTime"  BIGINT  NOT NULL,
      "firstSeenAt"   BIGINT  NOT NULL,
      "snapshotJson"  TEXT    NOT NULL DEFAULT '{}',
      "status"        TEXT    NOT NULL DEFAULT 'ACTIVE',
      "cancelReason"  TEXT,
      "openPositionId" TEXT,
      "createdAt"     DATETIME NOT NULL,
      "updatedAt"     DATETIME NOT NULL
    )`,
    },
    {
      table: 'TrendTradeMeta',
      cols: ['entryBarTime', 'mfeAt', 'firstEndSignAt'],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "TrendTradeMeta_trendCycleId_idx" ON "TrendTradeMeta"("trendCycleId")`,
        `CREATE INDEX IF NOT EXISTS "TrendTradeMeta_status_idx" ON "TrendTradeMeta"("status")`,
      ],
      ddl: `
    CREATE TABLE "TrendTradeMeta__mig" (
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
      "updatedAt"        DATETIME NOT NULL,
      "entryEr"          REAL,
      "htf5mDir"         TEXT,
      "htf15mDir"        TEXT,
      "htfGate"          TEXT,
      "entryNotional"    REAL,
      "entryBarTime"     BIGINT,
      "mfe"              REAL,
      "mae"              REAL,
      "mfeAt"            BIGINT,
      "mfeDrawdown"      REAL,
      "firstEndSignAt"   BIGINT,
      "exitEndReason"    TEXT,
      "exitEvidenceBars" INTEGER,
      "closeNotional"    REAL,
      "entryRound"       INTEGER
    )`,
    },
  ];
  for (const plan of plans) {
    try {
      const cols = await client.$queryRawUnsafe<{ name: string; type: string }[]>(
        `PRAGMA table_info('${plan.table}')`,
      );
      if (cols.length === 0) continue; // 表尚未创建：交给后续 CREATE TABLE
      const need = plan.cols.some((c) => {
        const col = cols.find((x) => x.name === c);
        return col && /INTEGER/i.test(col.type) && !/BIGINT/i.test(col.type);
      });
      if (!need) continue;
      const colList = cols.map((c) => `"${c.name}"`).join(', ');
      await client.$executeRawUnsafe(plan.ddl);
      await client.$executeRawUnsafe(
        `INSERT INTO "${plan.table}__mig" (${colList}) SELECT ${colList} FROM "${plan.table}"`,
      );
      await client.$executeRawUnsafe(`DROP TABLE "${plan.table}"`);
      await client.$executeRawUnsafe(
        `ALTER TABLE "${plan.table}__mig" RENAME TO "${plan.table}"`,
      );
      for (const idx of plan.indexes) await client.$executeRawUnsafe(idx);
      console.log(`[trend-trade] 迁移完成：${plan.table} 毫秒列 INTEGER → BIGINT（数据无损）`);
    } catch (e) {
      console.warn(`[trend-trade] ${plan.table} BIGINT 迁移失败（下轮重试）：`, e instanceof Error ? e.message : e);
    }
  }
}

/** 幂等建表 + 补列（与 schema.prisma 同步；已存在则跳过，无损） */
export async function ensureTrendTradeSchema(client: RawClient = db): Promise<void> {
  await migrateIntToBigint(client);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TrendAutoConfig" (
      "id"            TEXT    NOT NULL PRIMARY KEY,
      "name"          TEXT    NOT NULL UNIQUE,
      "mode"          TEXT    NOT NULL DEFAULT 'RUNNING',
      "initialCapital" REAL   NOT NULL,
      "marginRatio"   REAL    NOT NULL DEFAULT 0.2,
      "leverage"      REAL    NOT NULL DEFAULT 20,
      "maxPositions"  INTEGER NOT NULL DEFAULT 3,
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
  // Task 56 扩展列：PRAGMA 幂等补列（SQLite ADD COLUMN 无 IF NOT EXISTS）
  const metaCols = await client.$queryRawUnsafe<{ name: string }[]>(
    `PRAGMA table_info('TrendTradeMeta')`,
  );
  const have = new Set(metaCols.map((c) => c.name));
  const metaAlters: [string, string][] = [
    ['entryEr', `ALTER TABLE TrendTradeMeta ADD COLUMN entryEr REAL`],
    ['htf5mDir', `ALTER TABLE TrendTradeMeta ADD COLUMN htf5mDir TEXT`],
    ['htf15mDir', `ALTER TABLE TrendTradeMeta ADD COLUMN htf15mDir TEXT`],
    ['htfGate', `ALTER TABLE TrendTradeMeta ADD COLUMN htfGate TEXT`],
    ['entryNotional', `ALTER TABLE TrendTradeMeta ADD COLUMN entryNotional REAL`],
    ['entryBarTime', `ALTER TABLE TrendTradeMeta ADD COLUMN entryBarTime INTEGER`],
    ['mfe', `ALTER TABLE TrendTradeMeta ADD COLUMN mfe REAL`],
    ['mae', `ALTER TABLE TrendTradeMeta ADD COLUMN mae REAL`],
    ['mfeAt', `ALTER TABLE TrendTradeMeta ADD COLUMN mfeAt INTEGER`],
    ['mfeDrawdown', `ALTER TABLE TrendTradeMeta ADD COLUMN mfeDrawdown REAL`],
    ['firstEndSignAt', `ALTER TABLE TrendTradeMeta ADD COLUMN firstEndSignAt INTEGER`],
    ['exitEndReason', `ALTER TABLE TrendTradeMeta ADD COLUMN exitEndReason TEXT`],
    ['exitEvidenceBars', `ALTER TABLE TrendTradeMeta ADD COLUMN exitEvidenceBars INTEGER`],
    ['closeNotional', `ALTER TABLE TrendTradeMeta ADD COLUMN closeNotional REAL`],
  ];
  for (const [col, ddl] of metaAlters) {
    if (!have.has(col)) await client.$executeRawUnsafe(ddl);
  }
  // Task 57：TrendAutoConfig.strategyId（当前算法）——补列 + 存量行回填默认值
  const cfgCols = await client.$queryRawUnsafe<{ name: string }[]>(
    `PRAGMA table_info('TrendAutoConfig')`,
  );
  if (!cfgCols.some((c) => c.name === 'strategyId')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN strategyId TEXT`);
  }
  // Task 57-c：参数控制台——策略参数覆盖 / 二次确认开关 / 冷却时长（幂等补列）
  if (!cfgCols.some((c) => c.name === 'strategyParamsJson')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN strategyParamsJson TEXT`);
  }
  if (!cfgCols.some((c) => c.name === 'waitBarConfirm')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN waitBarConfirm INTEGER DEFAULT 1`);
  }
  if (!cfgCols.some((c) => c.name === 'cooldownMs')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN cooldownMs INTEGER`);
  }
  await client.$executeRawUnsafe(
    `UPDATE TrendAutoConfig SET strategyId = 'short-swing-v1' WHERE strategyId IS NULL`,
  );
  // Task 57：TrendTradeMeta.entryRound（开仓轮次，1 = 首次）
  if (!have.has('entryRound')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendTradeMeta ADD COLUMN entryRound INTEGER`);
  }
  // Task 57：策略每 symbol 状态（轮次/最近开平仓——重启恢复再入场语义；策略自由 JSON）
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TrendStrategyState" (
      "strategyId" TEXT NOT NULL,
      "symbol"     TEXT NOT NULL,
      "stateJson"  TEXT NOT NULL DEFAULT '{}',
      "updatedAt"  DATETIME NOT NULL,
      PRIMARY KEY ("strategyId", "symbol")
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
  // Task 56 §5.3：待入场记录（二次确认等待一根新收盘 K 线；重启从 DB 恢复）
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TrendPendingEntry" (
      "cycleId"       TEXT    NOT NULL PRIMARY KEY,
      "symbol"        TEXT    NOT NULL,
      "side"          TEXT    NOT NULL,
      "firstBarTime"  INTEGER NOT NULL,
      "firstSeenAt"   INTEGER NOT NULL,
      "snapshotJson"  TEXT    NOT NULL DEFAULT '{}',
      "status"        TEXT    NOT NULL DEFAULT 'ACTIVE',
      "cancelReason"  TEXT,
      "openPositionId" TEXT,
      "createdAt"     DATETIME NOT NULL,
      "updatedAt"     DATETIME NOT NULL
    )`);
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "TrendPendingEntry_status_idx" ON "TrendPendingEntry"("status")`,
  );
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "TrendPendingEntry_symbol_idx" ON "TrendPendingEntry"("symbol")`,
  );
}

function toMs(v: Date | number | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

function numOrNull(v: unknown): number | null {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
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
    netPnlWithSlip: numOrNull(row.netPnlWithSlip),
    openDecisionAt: toMs(row.openDecisionAt as Date | number | null),
    closedAt: toMs(row.closedAt as Date | number | null),
    entryEr: numOrNull(row.entryEr),
    htf5mDir: (row.htf5mDir as string | null) ?? null,
    htf15mDir: (row.htf15mDir as string | null) ?? null,
    htfGate: (row.htfGate as string | null) ?? null,
    entryNotional: numOrNull(row.entryNotional),
    entryBarTime: numOrNull(row.entryBarTime),
    mfe: numOrNull(row.mfe),
    mae: numOrNull(row.mae),
    mfeAt: numOrNull(row.mfeAt),
    mfeDrawdown: numOrNull(row.mfeDrawdown),
    firstEndSignAt: numOrNull(row.firstEndSignAt),
    exitEndReason: (row.exitEndReason as string | null) ?? null,
    exitEvidenceBars: numOrNull(row.exitEvidenceBars),
    closeNotional: numOrNull(row.closeNotional),
    entryRound: numOrNull(row.entryRound),
  };
}

const META_ALL_COLUMNS = `positionId, trendCycleId, symbol, side, trendPhaseAtOpen, scoreAtOpen,
  featuresAtOpen, signalAtOpen, slippageEst, status, exitReason, exitSignalJson,
  netPnlWithSlip, openDecisionAt, closedAt, updatedAt,
  entryEr, htf5mDir, htf15mDir, htfGate, entryNotional, entryBarTime,
  mfe, mae, mfeAt, mfeDrawdown, firstEndSignAt, exitEndReason, exitEvidenceBars, closeNotional,
  entryRound`;

export function createTrendTradeRepo(client: RawClient = db) {
  return {
    // ===== 配置 =====
    async loadConfig(name: string): Promise<TrendAutoConfigRow | null> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT name, mode, initialCapital, marginRatio, leverage, maxPositions, slippageBps, peakEquity, strategyId,
                strategyParamsJson, waitBarConfirm, cooldownMs
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
            strategyId: (r.strategyId as string | null) ?? undefined,
            strategyParamsJson: (r.strategyParamsJson as string | null) ?? null,
            waitBarConfirm: r.waitBarConfirm == null ? 1 : Number(r.waitBarConfirm),
            cooldownMs: numOrNull(r.cooldownMs),
          }
        : null;
    },

    async seedConfig(cfg: TrendAutoConfigRow): Promise<void> {
      const id = `trend-auto:${cfg.name}`;
      await client.$executeRawUnsafe(
        `INSERT INTO TrendAutoConfig
           (id, name, mode, initialCapital, marginRatio, leverage, maxPositions, slippageBps, peakEquity, strategyId, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        cfg.strategyId ?? 'short-swing-v1',
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

    /** 更新最大同时持仓数（界面可选；auto-trader 每 tick 重读配置，即时生效） */
    async updateMaxPositions(name: string, maxPositions: number): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET maxPositions = ?, updatedAt = ? WHERE name = ?`,
        maxPositions,
        new Date(),
        name,
      );
    },

    /** Task 57：切换交易策略（持久化；调用方负责先平仓清场） */
    async updateStrategyId(name: string, strategyId: string): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET strategyId = ?, updatedAt = ? WHERE name = ?`,
        strategyId,
        new Date(),
        name,
      );
    },

    /** Task 57-c：运行时参数（控制台）——策略参数 JSON / 二次确认开关 / 冷却时长。
     *  只更新传入的字段；全部白名单列，无拼接注入面。调用方负责热应用。 */
    async updateRuntimeParams(
      name: string,
      patch: { strategyParamsJson?: string | null; waitBarConfirm?: number; cooldownMs?: number | null },
    ): Promise<void> {
      const sets: string[] = ['updatedAt = ?'];
      const args: (string | number | Date | null)[] = [new Date()];
      if (patch.strategyParamsJson !== undefined) {
        sets.push('strategyParamsJson = ?');
        args.push(patch.strategyParamsJson);
      }
      if (patch.waitBarConfirm !== undefined) {
        sets.push('waitBarConfirm = ?');
        args.push(patch.waitBarConfirm);
      }
      if (patch.cooldownMs !== undefined) {
        sets.push('cooldownMs = ?');
        args.push(patch.cooldownMs);
      }
      args.push(name);
      await client.$executeRawUnsafe(
        `UPDATE TrendAutoConfig SET ${sets.join(', ')} WHERE name = ?`,
        ...args,
      );
    },

    // ===== Task 57：策略状态（轮次/最近开平仓；重启恢复再入场语义） =====
    async saveStrategyState(strategyId: string, symbol: string, stateJson: string): Promise<void> {
      await client.$executeRawUnsafe(
        `INSERT INTO TrendStrategyState (strategyId, symbol, stateJson, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(strategyId, symbol) DO UPDATE SET stateJson = excluded.stateJson, updatedAt = excluded.updatedAt`,
        strategyId,
        symbol,
        stateJson,
        new Date(),
      );
    },

    async loadStrategyStates(strategyId: string): Promise<Record<string, unknown>> {
      const rows = await client.$queryRawUnsafe<{ symbol: string; stateJson: string }[]>(
        `SELECT symbol, stateJson FROM TrendStrategyState WHERE strategyId = ?`,
        strategyId,
      );
      const out: Record<string, unknown> = {};
      for (const r of rows) {
        try {
          out[String(r.symbol)] = JSON.parse(String(r.stateJson));
        } catch {
          // 单条损坏跳过（不影响其余恢复）
        }
      }
      return out;
    },

    /** 清空某策略的存量状态（切换算法时旧状态作废） */
    async clearStrategyStates(strategyId: string): Promise<void> {
      await client.$executeRawUnsafe(`DELETE FROM TrendStrategyState WHERE strategyId = ?`, strategyId);
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

    /** 峰值无条件归零（重置账户专用；updatePeakEquity 是峰值语义，写入 0 不生效） */
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
           (${META_ALL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updatedAt = excluded.updatedAt,
           entryEr = excluded.entryEr,
           htf5mDir = excluded.htf5mDir,
           htf15mDir = excluded.htf15mDir,
           htfGate = excluded.htfGate,
           entryNotional = excluded.entryNotional,
           entryBarTime = excluded.entryBarTime,
           mfe = excluded.mfe,
           mae = excluded.mae,
           mfeAt = excluded.mfeAt,
           mfeDrawdown = excluded.mfeDrawdown,
           firstEndSignAt = excluded.firstEndSignAt,
           exitEndReason = excluded.exitEndReason,
           exitEvidenceBars = excluded.exitEvidenceBars,
           closeNotional = excluded.closeNotional,
           entryRound = excluded.entryRound`,
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
        meta.entryEr ?? null,
        meta.htf5mDir ?? null,
        meta.htf15mDir ?? null,
        meta.htfGate ?? null,
        meta.entryNotional ?? null,
        meta.entryBarTime ?? null,
        meta.mfe ?? null,
        meta.mae ?? null,
        meta.mfeAt ?? null,
        meta.mfeDrawdown ?? null,
        meta.firstEndSignAt ?? null,
        meta.exitEndReason ?? null,
        meta.exitEvidenceBars ?? null,
        meta.closeNotional ?? null,
        meta.entryRound ?? null,
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

    /** 最近一次该 symbol 的平仓时刻（「先平后开」独立性 + 同币种冷却共用） */
    async lastCloseAt(symbol: string): Promise<number | null> {
      const rows = await client.$queryRawUnsafe<{ closedAt: Date | number | null }[]>(
        `SELECT closedAt FROM TrendTradeMeta
         WHERE symbol = ? AND status = 'CLOSED' AND closedAt IS NOT NULL
         ORDER BY closedAt DESC LIMIT 1`,
        symbol,
      );
      return rows[0] ? toMs(rows[0].closedAt) : null;
    },

    // ===== Task 56：MFE/MAE 增量更新（仅统计列，独立轻量 UPDATE） =====
    async updateTradeStats(
      positionId: string,
      stats: { mfe: number; mae: number; mfeAt: number | null; mfeDrawdown: number },
    ): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendTradeMeta
         SET mfe = ?, mae = ?, mfeAt = ?, mfeDrawdown = ?, updatedAt = ?
         WHERE positionId = ?`,
        stats.mfe,
        stats.mae,
        stats.mfeAt != null ? new Date(stats.mfeAt) : null,
        stats.mfeDrawdown,
        new Date(),
        positionId,
      );
    },

    /** 首次结束迹象时刻（一次写入，后续不覆盖——保留最早的报警时间） */
    async markFirstEndSign(positionId: string, at: number): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendTradeMeta
         SET firstEndSignAt = ?, updatedAt = ?
         WHERE positionId = ? AND firstEndSignAt IS NULL`,
        new Date(at),
        new Date(),
        positionId,
      );
    },

    // ===== Task 56 §5.3：待入场记录（每周期一条；重启恢复） =====
    async upsertPending(p: TrendPendingEntryRow): Promise<void> {
      await client.$executeRawUnsafe(
        `INSERT INTO TrendPendingEntry
           (cycleId, symbol, side, firstBarTime, firstSeenAt, snapshotJson, status, cancelReason, openPositionId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cycleId) DO UPDATE SET
           symbol = excluded.symbol,
           side = excluded.side,
           firstBarTime = excluded.firstBarTime,
           firstSeenAt = excluded.firstSeenAt,
           snapshotJson = excluded.snapshotJson,
           status = excluded.status,
           cancelReason = excluded.cancelReason,
           openPositionId = excluded.openPositionId,
           updatedAt = excluded.updatedAt`,
        p.cycleId,
        p.symbol,
        p.side,
        p.firstBarTime,
        p.firstSeenAt,
        p.snapshotJson,
        p.status,
        p.cancelReason,
        p.openPositionId,
        new Date(p.createdAt),
        new Date(),
      );
    },

    async getPendingByCycle(cycleId: string): Promise<TrendPendingEntryRow | null> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM TrendPendingEntry WHERE cycleId = ?`,
        cycleId,
      );
      return rows[0] ? pendingFromRow(rows[0]) : null;
    },

    async getActivePendingBySymbol(symbol: string): Promise<TrendPendingEntryRow | null> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM TrendPendingEntry WHERE symbol = ? AND status = 'ACTIVE' LIMIT 1`,
        symbol,
      );
      return rows[0] ? pendingFromRow(rows[0]) : null;
    },

    /** 同周期幂等抢占待入场记录（INSERT OR IGNORE；返回 true = 本进程抢占成功） */
    async claimPending(p: TrendPendingEntryRow): Promise<boolean> {
      const changes = await client.$executeRawUnsafe(
        `INSERT OR IGNORE INTO TrendPendingEntry
           (cycleId, symbol, side, firstBarTime, firstSeenAt, snapshotJson, status, cancelReason, openPositionId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, ?, ?)`,
        p.cycleId,
        p.symbol,
        p.side,
        p.firstBarTime,
        p.firstSeenAt,
        p.snapshotJson,
        new Date(p.createdAt),
        new Date(),
      );
      return changes > 0;
    },

    async loadActivePendings(): Promise<TrendPendingEntryRow[]> {
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM TrendPendingEntry WHERE status = 'ACTIVE' ORDER BY firstSeenAt`,
      );
      return rows.map(pendingFromRow);
    },

    async markPendingConverted(cycleId: string, positionId: string): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendPendingEntry
         SET status = 'CONVERTED', openPositionId = ?, updatedAt = ?
         WHERE cycleId = ? AND status = 'ACTIVE'`,
        positionId,
        new Date(),
        cycleId,
      );
    },

    async markPendingCanceled(cycleId: string, reason: string): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendPendingEntry
         SET status = 'CANCELED', cancelReason = ?, updatedAt = ?
         WHERE cycleId = ? AND status = 'ACTIVE'`,
        reason,
        new Date(),
        cycleId,
      );
    },

    /** 删除待入场记录（暂时性开仓失败后允许同周期下一轮重建；与 CANCELED 终态区分） */
    async deletePending(cycleId: string): Promise<void> {
      await client.$executeRawUnsafe(`DELETE FROM TrendPendingEntry WHERE cycleId = ?`, cycleId);
    },
  };
}

function pendingFromRow(row: Record<string, unknown>): TrendPendingEntryRow {
  return {
    cycleId: String(row.cycleId),
    symbol: String(row.symbol),
    side: String(row.side),
    firstBarTime: Number(row.firstBarTime ?? 0),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    snapshotJson: String(row.snapshotJson ?? '{}'),
    status: String(row.status ?? 'ACTIVE'),
    cancelReason: (row.cancelReason as string | null) ?? null,
    openPositionId: (row.openPositionId as string | null) ?? null,
    createdAt: toMs(row.createdAt as Date | number | null) ?? 0,
    updatedAt: toMs(row.updatedAt as Date | number | null) ?? 0,
  };
}

export type TrendTradeRepo = ReturnType<typeof createTrendTradeRepo>;

/** 生产默认 repo */
export const trendTradeRepo: TrendTradeRepo = createTrendTradeRepo();
