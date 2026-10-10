import { NextResponse } from 'next/server';
import { paperEngine } from '@/lib/market/paper';
import type { PaperAccountResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snap = await paperEngine.snapshot();
    const res: PaperAccountResponse = {
      ok: true,
      ts: snap.ts,
      account: snap.account,
      positions: snap.positions,
      history: snap.history,
    };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
