import { NextResponse } from 'next/server';
import { paperEngine, PaperError } from '@/lib/market/paper';
import type { PaperCloseAllResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await paperEngine.closeAll();
    const res: PaperCloseAllResponse = { ok: true, ...result };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = e instanceof PaperError ? e.message : e instanceof Error ? e.message : '一键平仓失败';
    const status = e instanceof PaperError ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
