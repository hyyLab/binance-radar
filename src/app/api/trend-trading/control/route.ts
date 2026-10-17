import { NextResponse } from 'next/server';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';

export const dynamic = 'force-dynamic';

/**
 * 趋势自动模拟交易 · 控制（Task 54 §5.3：操作语义明确分离）
 * POST /api/trend-trading/control  body: { action, positionId? }
 *
 * - start    ：开启自动交易（mode=RUNNING；服务未启动则拉起）
 * - pause    ：暂停「新开仓」——现有持仓继续受监控（退出管理 + 强平巡检不停）
 * - resume   ：恢复新开仓（mode=RUNNING）
 * - closeAll ：按标记价市价平掉全部自动持仓（mode 不变——全平 ≠ 暂停）
 * - close    ：平掉单笔持仓（body.positionId）
 *
 * ⚠️ 纯模拟；不接入真实下单。暂停与全部平仓是两个独立操作，不混为一谈。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; positionId?: string };
    const engine = getEnhancedEngine();
    await engine.ensureStarted();
    await engine.autoTrader.ensureStarted();

    switch (body.action) {
      case 'start':
      case 'resume': {
        await engine.autoTrader.resume();
        return NextResponse.json({ ok: true, mode: 'RUNNING' });
      }
      case 'pause': {
        await engine.autoTrader.pause();
        return NextResponse.json({
          ok: true,
          mode: 'PAUSED',
          note: '已暂停新开仓；现有持仓继续监控（趋势结束/反向确认照常离场，强平巡检不停）',
        });
      }
      case 'closeAll': {
        const r = await engine.autoTrader.closeAllManual();
        return NextResponse.json({ ok: true, ...r });
      }
      case 'close': {
        if (!body.positionId) {
          return NextResponse.json({ ok: false, error: '缺少 positionId' }, { status: 400 });
        }
        const r = await engine.autoTrader.closeOne(body.positionId);
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }
      default:
        return NextResponse.json(
          { ok: false, error: `未知操作：${body.action ?? '(空)'}；支持 start/pause/resume/closeAll/close` },
          { status: 400 },
        );
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'control error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

/** GET：返回当前模式与账户名（页面初始化用） */
export async function GET() {
  const engine = getEnhancedEngine();
  const mode = await engine.autoTrader.mode();
  return NextResponse.json(
    { ok: true, mode: mode ?? 'RUNNING', accountName: TREND_TRADE.ACCOUNT_NAME },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
