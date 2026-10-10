import { NextResponse } from 'next/server';
import { scanner } from '@/lib/market/scanner';
import type { LevelsResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await scanner.ensureStarted();
    const res: LevelsResponse = {
      ok: true,
      ts: Date.now(),
      status: scanner.getStatus(),
      data: scanner.getLevels(),
    };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
