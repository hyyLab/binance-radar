import { NextResponse } from 'next/server';
import { getEnhancedEngine, resetEnhancedEngine } from '@/lib/market/enhanced/engine';

export const dynamic = 'force-dynamic';

/**
 * 升级版异动交易 · 事件流
 * GET /api/enhanced/anomalies → { ok, ts, events: { active, ended }, stats }
 * 首次访问时启动引擎（等 collector 就绪后开始 K 线回填，冷启动回填并发受控）。
 * ?reset=1 → 热重置引擎实例（应用新代码，携带 K 线仓库，不重复回填；运维用）。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const engine = url.searchParams.get('reset') === '1' ? resetEnhancedEngine() : getEnhancedEngine();
    await engine.ensureStarted();
    const now = Date.now();
    const { active, ended } = engine.events(now);
    return NextResponse.json(
      {
        ok: true,
        ts: now,
        events: { active, ended },
        stats: engine.stats(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'enhanced engine error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
