import { NextResponse } from 'next/server';
import { collector } from '@/lib/market/collector';
import type { TickersResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await collector.ensureStarted();
    const data = collector.getTickers();
    const res: TickersResponse = {
      ok: true,
      ts: Date.now(),
      count: data.length,
      data,
    };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
