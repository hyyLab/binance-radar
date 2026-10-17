// ---------- 趋势跟踪持久化 · Prisma 往返测试（独立测试库，不触碰 db/custom.db） ----------
// 覆盖任务第 6 条：数据库保存和恢复后，候选池及趋势确认状态不丢失。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { createPrismaTrendWatchRepo } from '@/lib/market/trend-watch/repo';
import type { TrendWatchRecord } from '@/lib/market/trend-watch/types';

const TEST_DB_URL = 'file:/home/z/my-project/db/trend-watch-test.db';

let client: PrismaClient;
let repo: ReturnType<typeof createPrismaTrendWatchRepo>;

beforeAll(() => {
  // 测试库 schema 与 prisma/schema.prisma 保持同步（只建表，不触碰 db/custom.db）
  execSync('bunx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    cwd: '/home/z/my-project',
    stdio: 'pipe',
  });
});

function rec(partial: Partial<TrendWatchRecord> & { symbol: string }): TrendWatchRecord {
  return {
    market: 'futures',
    interval: '1m',
    status: 'WATCHING',
    addedAt: 1_700_000_000_000,
    lastAnomalyAt: 1_700_000_060_000,
    expiresAt: 1_700_001_800_000,
    trendStateJson: JSON.stringify({
      symbol: partial.symbol,
      phase: 'confirmed',
      direction: 'up',
      candidateDirection: 'up',
      consecutiveObservations: 3,
      changedAt: 1_700_000_300_000,
      lastUpdatedAt: 1_700_000_360_000,
      lastObservationKey: 1_700_000_360_000, // 同根去重键（恢复后仍生效）
      lastScore: 72,
    }),
    lastSignalJson: null,
    lastPhase: 'confirmed',
    lastDirection: 'up',
    lastScore: 72,
    lastBarTime: 1_700_000_300_000,
    lastKlineAt: 1_700_000_360_000,
    ...partial,
  };
}

beforeEach(async () => {
  client = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await client.trendWatchSymbol.deleteMany(); // 测试库清空（独立文件，非用户库）
  repo = createPrismaTrendWatchRepo(client);
});

afterAll(async () => {
  await client.$disconnect();
});

describe('TrendWatchRepo (Prisma/SQLite)', () => {
  test('upsert → loadActive 往返：字段与 JSON 保真', async () => {
    const a = rec({ symbol: 'BTCUSDT' });
    const b = rec({ symbol: 'ETHUSDT', lastPhase: 'candidate', lastDirection: 'down', lastScore: 41 });
    await repo.upsert(a);
    await repo.upsert(b);

    const rows = await repo.loadActive();
    expect(rows.length).toBe(2);
    const got = rows.find((r) => r.symbol === 'BTCUSDT')!;
    expect(got.status).toBe('WATCHING');
    expect(got.market).toBe('futures');
    expect(got.interval).toBe('1m');
    expect(got.lastPhase).toBe('confirmed');
    expect(got.lastDirection).toBe('up');
    expect(got.lastScore).toBe(72);
    expect(got.lastBarTime).toBe(1_700_000_300_000);
    expect(got.lastKlineAt).toBe(1_700_000_360_000);
    expect(got.expiresAt).toBe(1_700_001_800_000);
    // 确认历史 JSON 往返保真
    const state = JSON.parse(got.trendStateJson) as { phase: string; lastObservationKey: number };
    expect(state.phase).toBe('confirmed');
    expect(state.lastObservationKey).toBe(1_700_000_360_000);
  });

  test('同键重复 upsert 覆盖不重复建行', async () => {
    await repo.upsert(rec({ symbol: 'BTCUSDT', lastScore: 50 }));
    await repo.upsert(rec({ symbol: 'BTCUSDT', lastScore: 88 }));
    const rows = await repo.loadActive();
    expect(rows.length).toBe(1);
    expect(rows[0]!.lastScore).toBe(88);
  });

  test('markRetired 后 loadActive 不含该行（重启不复活已退池标的）', async () => {
    await repo.upsert(rec({ symbol: 'BTCUSDT' }));
    await repo.upsert(rec({ symbol: 'ETHUSDT' }));
    await repo.markRetired('BTCUSDT', 'futures', '1m');
    const rows = await repo.loadActive();
    expect(rows.map((r) => r.symbol)).toEqual(['ETHUSDT']);
    // 重复 retire 安全（无行时 updateMany 影响 0 行）
    await repo.markRetired('NOPEUSDT', 'futures', '1m');
  });
});
