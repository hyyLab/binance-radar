import { NextResponse } from 'next/server';
import { paperEngine, PaperError } from '@/lib/market/paper';
import type { PaperCloseResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { positionId?: unknown };
    const positionId = typeof body.positionId === 'string' ? body.positionId : '';
    if (!positionId) {
      return NextResponse.json({ ok: false, error: '缺少 positionId' }, { status: 400 });
    }
    const result = await paperEngine.close(positionId);
    const res: PaperCloseResponse = { ok: true, ...result };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = e instanceof PaperError ? e.message : e instanceof Error ? e.message : '平仓失败';
    const status = e instanceof PaperError ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
