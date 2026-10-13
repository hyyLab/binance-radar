import { NextResponse } from 'next/server';
import { paperEngine, PaperError } from '@/lib/market/paper';
import type { PaperAddResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { positionId?: unknown; margin?: unknown };
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    const margin = typeof body.margin === 'number' ? body.margin : Number(body.margin);
    if (!positionId) {
      return NextResponse.json({ ok: false, error: '缺少 positionId' }, { status: 400 });
    }
    if (!Number.isFinite(margin)) {
      return NextResponse.json({ ok: false, error: '加仓金额无效' }, { status: 400 });
    }
    const result = await paperEngine.addToPosition(positionId, margin);
    const res: PaperAddResponse = { ok: true, ...result };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = e instanceof PaperError ? e.message : e instanceof Error ? e.message : '加仓失败';
    const status = e instanceof PaperError ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
