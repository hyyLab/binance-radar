// GET /api/pa-analysis/candidates?status=&pool=&q=
// 候选币种列表（支持按状态/来源池/关键字过滤；含池来源、UTE、PA、协同、决策、原因）

import { db } from '@/lib/db';
import { paApiBoot } from '@/lib/pa-integration/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await paApiBoot();
    const url = new URL(req.url);
    const status = url.searchParams.get('status') ?? undefined;
    const pool = url.searchParams.get('pool') ?? undefined;
    const q = (url.searchParams.get('q') ?? '').toUpperCase().trim();
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);

    const rows = await db.paCandidate.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 500,
    });

    let out = rows;
    if (pool) {
      out = out.filter((r) => {
        try {
          const pools = JSON.parse(r.sourcePoolsJson) as { poolId: string }[];
          return pools.some((p) => p.poolId === pool);
        } catch {
          return false;
        }
      });
    }
    if (q) out = out.filter((r) => r.symbol.includes(q));

    return Response.json({
      ok: true,
      ts: Date.now(),
      total: out.length,
      candidates: out.slice(0, limit).map((r) => ({
        symbol: r.symbol,
        status: r.status,
        sourcePools: JSON.parse(r.sourcePoolsJson || '[]'),
        uteDirection: r.uteDirection,
        utePhase: r.utePhase,
        uteScore: r.uteScore,
        trendCycleId: r.trendCycleId,
        coordinationState: r.coordinationState,
        coordinationDecision: r.coordinationDecision,
        lastAnalysisId: r.lastAnalysisId,
        lastAnalysisAt: r.lastAnalysisAt,
        lastReason: r.lastReason,
        pendingOrderId: r.pendingOrderId,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
