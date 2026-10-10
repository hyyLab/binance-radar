import { NextResponse } from 'next/server';
import { paperEngine, PaperError } from '@/lib/market/paper';
import type { PaperDepositResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { amount?: unknown };
    const amount = Number(body.amount);
    const result = await paperEngine.deposit(amount);
    const res: PaperDepositResponse = { ok: true, ...result };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = e instanceof PaperError ? e.message : e instanceof Error ? e.message : '充值失败';
    const status = e instanceof PaperError ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
