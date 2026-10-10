import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { paperEngine } from '@/lib/market/paper';
import type { PaperTradeDTO, PaperTradesResponse, TradeAction } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

/** 按币种查询模拟交易流水（用于 K 线图标注开仓/平仓位置） */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
    let limit = Number(url.searchParams.get('limit') ?? 60);
    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
      return NextResponse.json({ ok: false, error: 'invalid symbol' }, { status: 400 });
    }
    if (!Number.isFinite(limit) || limit < 1) limit = 60;
    if (limit > 200) limit = 200;

    const acc = await paperEngine.getAccountId();
    const rows = await db.paperTrade.findMany({
      where: { accountId: acc, symbol },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const data: PaperTradeDTO[] = rows.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      action: t.action as TradeAction,
      price: t.price,
      qty: t.qty,
      fee: t.fee,
      pnl: t.pnl,
      createdAt: t.createdAt.toISOString(),
    }));

    const res: PaperTradesResponse = { ok: true, ts: Date.now(), count: data.length, data };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
