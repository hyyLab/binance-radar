import { NextResponse } from 'next/server';
import { paperEngine, PaperError } from '@/lib/market/paper';
import type { PaperOpenResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      symbol?: unknown;
      side?: unknown;
      leverage?: unknown;
      margin?: unknown;
    };

    const symbol = typeof body.symbol === 'string' ? body.symbol.toUpperCase().trim() : '';
    const side = body.side === 'SHORT' ? 'SHORT' : body.side === 'LONG' ? 'LONG' : null;
    const leverage = Number(body.leverage);
    const margin = Number(body.margin);

    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
      return NextResponse.json({ ok: false, error: '无效的交易对' }, { status: 400 });
    }
    if (!side) {
      return NextResponse.json({ ok: false, error: '无效的方向' }, { status: 400 });
    }

    const position = await paperEngine.open({ symbol, side, leverage, margin });
    const res: PaperOpenResponse = { ok: true, position };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = e instanceof PaperError ? e.message : e instanceof Error ? e.message : '开仓失败';
    const status = e instanceof PaperError ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
