// POST /api/pa-analysis/orders/[id]/cancel —— 撤销待入场单（服务端执行；幂等）

import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { paScheduler } from '@/lib/pa-integration/scheduler';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await paApiBoot();
    const { id } = await ctx.params;
    const r = await paScheduler().trader.cancelOrder(id);
    return Response.json({ ok: r.ok, message: r.message }, { status: r.ok ? 200 : 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
