import { NextResponse } from 'next/server';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';

export const dynamic = 'force-dynamic';

/**
 * 趋势跟踪（Universal Trend Engine 集成）
 * GET /api/enhanced/trends → { ok, ts, interval, market, pool: TrendWatchRow[], stats }
 * 首次访问时随引擎启动趋势服务（从 DB 恢复候选池与确认历史）。
 * 候选池与异动事件分开维护：已确认趋势不因异动事件结束而消失。
 * 趋势评分为启发式证据分，不构成交易建议；第一版无自动交易。
 */
export async function GET() {
  try {
    const engine = getEnhancedEngine();
    await engine.ensureStarted();
    const tw = engine.trendWatch;
    await tw.ensureStarted(); // 显式等待 DB 恢复完成（boot 内已拉起，此处幂等）
    const now = Date.now();
    const snap = tw.snapshot(now);
    return NextResponse.json(
      { ok: true, ...snap },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'trend watch error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
