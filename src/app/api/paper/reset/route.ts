import { NextResponse } from 'next/server';
import { paperEngine } from '@/lib/market/paper';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await paperEngine.reset();
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : '重置失败' },
      { status: 500 },
    );
  }
}
