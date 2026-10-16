import { NextResponse } from 'next/server';
import { activeFuturesCollector } from '@/lib/market/futures-collector';
import type { TickersResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

/**
 * 升级版异动交易 · 合约行情快照（USDT-M 永续，多源聚合，币安优先）
 * GET /api/enhanced/tickers → { ok, ts, count, data }
 * 供交易弹窗的币种搜索/最新价展示（与模拟盘 markPrice 同一数据源）。
 */
export async function GET() {
  try {
    const col = activeFuturesCollector();
    await col.ensureStarted();
    const data = col.getTickers();
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
