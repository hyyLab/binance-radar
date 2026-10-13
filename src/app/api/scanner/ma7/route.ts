import { NextResponse } from 'next/server';
import { ma7Scanner } from '@/lib/market/ma7';
import type { Ma7Response } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

// M(7) 沿线趋势已从 UI 移除（用户决策）。本路由只读不再 ensureStarted 自启扫描器，
// 防止未来重启后残留请求把扫描拉起来；结果为内存缓存（新进程恒为空）。
export async function GET() {
  const res: Ma7Response = {
    ok: true,
    ts: Date.now(),
    status: ma7Scanner.getStatus(),
    data: ma7Scanner.getRows(),
  };
  return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
}
