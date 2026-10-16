// ---------- 趋势跟踪 · Prisma 持久化（SQLite，raw SQL） ----------
// 用 $executeRawUnsafe/$queryRawUnsafe 实现（而非 generated 模型 API）：
// dev server 进程可能缓存 schema 变更前的旧 PrismaClient（无 trendWatchSymbol 属性），
// raw SQL 对新旧 client 一致可用；表结构与 prisma/schema.prisma 同步（db push 维护）。
//
// 写入纪律：只在入池/状态变化/新 K 线/生命周期变化时 upsert，不每轮扫描无条件写库。
// 恢复：loadActive() 返回所有 WATCHING 行（含 UTE trendStateJson），重启后重建候选池
// 与每个标的的趋势确认历史。仅新增表，不动既有模型；不执行任何 reset 操作。
//
// DateTime 存储格式：Prisma 6 SQLite = 毫秒整数；$queryRaw 读回自动转 Date 对象。

import { db } from '@/lib/db';
import type { TrendWatchRecord, TrendWatchRepo } from './types';
import type { PrismaClient } from '@prisma/client';

const MARKET = 'futures';
const INTERVAL = '1m';

type RawClient = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

interface RawRow {
  symbol: string;
  market: string;
  interval: string;
  status: string;
  addedAt: Date | number | null;
  lastAnomalyAt: Date | number | null;
  expiresAt: Date | number | null;
  trendStateJson: string;
  lastSignalJson: string | null;
  lastPhase: string;
  lastDirection: string;
  lastScore: number;
  lastBarTime: Date | number | null;
  lastKlineAt: Date | number | null;
}

function toMs(v: Date | number | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

function toRecord(row: RawRow): TrendWatchRecord {
  return {
    symbol: row.symbol,
    market: row.market,
    interval: row.interval,
    status: row.status === 'RETIRED' ? 'RETIRED' : 'WATCHING',
    addedAt: toMs(row.addedAt) ?? 0,
    lastAnomalyAt: toMs(row.lastAnomalyAt),
    expiresAt: toMs(row.expiresAt),
    trendStateJson: row.trendStateJson,
    lastSignalJson: row.lastSignalJson,
    lastPhase: (row.lastPhase as TrendWatchRecord['lastPhase']) ?? 'idle',
    lastDirection: (row.lastDirection as TrendWatchRecord['lastDirection']) ?? 'flat',
    lastScore: row.lastScore,
    lastBarTime: toMs(row.lastBarTime),
    lastKlineAt: toMs(row.lastKlineAt),
  };
}

export function createPrismaTrendWatchRepo(client: RawClient = db): TrendWatchRepo {
  return {
    async loadActive(): Promise<TrendWatchRecord[]> {
      const rows = await client.$queryRawUnsafe<RawRow[]>(
        `SELECT symbol, market, interval, status, addedAt, lastAnomalyAt, expiresAt,
                trendStateJson, lastSignalJson, lastPhase, lastDirection, lastScore,
                lastBarTime, lastKlineAt
         FROM TrendWatchSymbol
         WHERE market = ? AND interval = ? AND status = 'WATCHING'`,
        MARKET,
        INTERVAL,
      );
      return rows.map(toRecord);
    },

    async upsert(rec: TrendWatchRecord): Promise<void> {
      // id 确定性：重入稳定，ON CONFLICT 时不改主键
      const id = `${rec.symbol}:${rec.market}:${rec.interval}`;
      await client.$executeRawUnsafe(
        `INSERT INTO TrendWatchSymbol
           (id, symbol, market, interval, status, addedAt, lastAnomalyAt, expiresAt,
            trendStateJson, lastSignalJson, lastPhase, lastDirection, lastScore,
            lastBarTime, lastKlineAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, market, interval) DO UPDATE SET
           status = excluded.status,
           addedAt = excluded.addedAt,
           lastAnomalyAt = excluded.lastAnomalyAt,
           expiresAt = excluded.expiresAt,
           trendStateJson = excluded.trendStateJson,
           lastSignalJson = excluded.lastSignalJson,
           lastPhase = excluded.lastPhase,
           lastDirection = excluded.lastDirection,
           lastScore = excluded.lastScore,
           lastBarTime = excluded.lastBarTime,
           lastKlineAt = excluded.lastKlineAt,
           updatedAt = excluded.updatedAt`,
        id,
        rec.symbol,
        rec.market,
        rec.interval,
        rec.status,
        new Date(rec.addedAt),
        rec.lastAnomalyAt != null ? new Date(rec.lastAnomalyAt) : null,
        rec.expiresAt != null ? new Date(rec.expiresAt) : null,
        rec.trendStateJson,
        rec.lastSignalJson,
        rec.lastPhase,
        rec.lastDirection,
        rec.lastScore,
        rec.lastBarTime != null ? new Date(rec.lastBarTime) : null,
        rec.lastKlineAt != null ? new Date(rec.lastKlineAt) : null,
        new Date(),
      );
    },

    async markRetired(symbol: string): Promise<void> {
      await client.$executeRawUnsafe(
        `UPDATE TrendWatchSymbol SET status = 'RETIRED', updatedAt = ?
         WHERE symbol = ? AND market = ? AND interval = ? AND status = 'WATCHING'`,
        new Date(),
        symbol,
        MARKET,
        INTERVAL,
      );
    },
  };
}

/** 生产默认 repo（Prisma 单例；raw SQL 对 schema 变更前后的 client 均可用） */
export const prismaTrendWatchRepo: TrendWatchRepo = createPrismaTrendWatchRepo();
