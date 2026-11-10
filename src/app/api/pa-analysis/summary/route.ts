// GET /api/pa-analysis/summary —— 总览（概览区 + 自动交易区数据源）
// 返回：扫描范围（5 池明细）、候选统计、协同四态计数、调度器/队列状态、账户与策略统计。

import { db } from '@/lib/db';
import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { loadPaConfig } from '@/lib/pa-integration/config';
import { paScheduler } from '@/lib/pa-integration/scheduler';
import { paStats } from '@/lib/pa-integration/stats';
import { readPoolUniverse } from '@/lib/pa-integration/pool-universe';
import { lastScanStats } from '@/lib/pa-integration/candidate-scanner';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await paApiBoot();
    const [cfg, stats, sched] = await Promise.all([
      loadPaConfig(),
      paStats(),
      Promise.resolve(paScheduler()),
    ]);

    const candidates = await db.paCandidate.groupBy({ by: ['status'], _count: true });
    const coord = await db.paCandidate.groupBy({
      by: ['coordinationState'],
      _count: true,
      where: { coordinationState: { not: null } },
    });

    // 池宇宙（实时读取——页面展示扫描范围与各池来源数）
    const universe = await readPoolUniverse();

    const overview = await sched.trader.overview();
    const lastScan = lastScanStats();

    return Response.json({
      ok: true,
      ts: Date.now(),
      config: cfg,
      stats: { ...stats, openPositions: overview.openPositions, activePendings: overview.activePendings },
      candidateStatus: Object.fromEntries(candidates.map((c) => [c.status, c._count])),
      coordination: Object.fromEntries(coord.map((c) => [c.coordinationState, c._count])),
      pools: universe.pools,
      universe: { totalRaw: universe.totalRaw, unique: universe.entries.length, ts: universe.ts },
      scheduler: sched.stats(),
      lastScan,
      equity: overview.equity,
      balance: overview.balance,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
