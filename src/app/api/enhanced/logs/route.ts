import { NextResponse } from 'next/server';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';

export const dynamic = 'force-dynamic';

/**
 * 升级版异动交易 · 检测日志（规格书 §十二 回放评估用，环形缓冲 2000 条）
 * GET /api/enhanced/logs?limit=200
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
    const engine = getEnhancedEngine();
    await engine.ensureStarted();
    return NextResponse.json(
      { ok: true, ts: Date.now(), logs: engine.recentLogs(limit) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'enhanced logs error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
