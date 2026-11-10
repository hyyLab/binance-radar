// GET /api/pa-analysis/orders —— 待入场单列表（ACTIVE 优先 + 最近历史）

import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { paRepo } from '@/lib/pa-integration/repo';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await paApiBoot();
    const active = await paRepo.loadPendingOrders('ACTIVE');
    const recent = (await paRepo.loadPendingOrders()).filter((p) => p.status !== 'ACTIVE').slice(0, 50);
    return Response.json({ ok: true, ts: Date.now(), active, recent });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
