// GET /api/pa-analysis/history?symbol=&limit= —— PA 分析历史（含协同/计划/校验留痕）

import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { paRepo } from '@/lib/pa-integration/repo';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await paApiBoot();
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol') ?? undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
    const rows = await paRepo.listAnalyses({ symbol, limit });
    return Response.json({ ok: true, ts: Date.now(), total: rows.length, records: rows });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
