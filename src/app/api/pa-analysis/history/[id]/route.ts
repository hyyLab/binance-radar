// GET /api/pa-analysis/history/[id] —— 单条分析详情（UTE 快照/Stage1 诊断/15m 背景/协同证据/计划/校验清单）

import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { paRepo } from '@/lib/pa-integration/repo';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await paApiBoot();
    const { id } = await ctx.params;
    const rec = await paRepo.getAnalysis(id);
    if (!rec) return Response.json({ ok: false, error: '分析记录不存在' }, { status: 404 });
    return Response.json({
      ok: true,
      record: {
        ...rec,
        uteSnapshot: JSON.parse(rec.uteSnapshotJson || '{}'),
        diagnosis: JSON.parse(rec.diagnosisJson || '{}'),
        htf: JSON.parse(rec.htfJson || '{}'),
        coordination: JSON.parse(rec.coordinationJson || '{}'),
        rawPlan: rec.rawPlanJson ? JSON.parse(rec.rawPlanJson) : null,
        plan: rec.planJson ? JSON.parse(rec.planJson) : null,
        validator: rec.validatorJson ? JSON.parse(rec.validatorJson) : null,
      },
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
