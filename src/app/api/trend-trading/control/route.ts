import { NextResponse } from 'next/server';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { paperEngineFor } from '@/lib/market/paper';
import { ensureTrendTradeSchema, trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';

export const dynamic = 'force-dynamic';

/**
 * 趋势自动模拟交易 · 控制（Task 54 §5.3：操作语义明确分离）
 * POST /api/trend-trading/control  body: { action, positionId?, amount?, value? }
 *
 * - start    ：开启自动交易（mode=RUNNING；服务未启动则拉起）
 * - pause    ：暂停「新开仓」——现有持仓继续受监控（退出管理 + 强平巡检不停）
 * - resume   ：恢复新开仓（mode=RUNNING）
 * - closeAll ：按标记价市价平掉全部自动持仓（mode 不变——全平 ≠ 暂停）
 * - close    ：平掉单笔持仓（body.positionId）
 * - deposit  ：给机器人账户充值（Task 55：增加可用余额与 ROI 本金基数，不计入盈亏）
 * - setMaxPositions：设置持仓数量/最大同时持仓数（Task 55：可选；更换时自动平仓
 *   原有持仓，每仓保证金 = 可用余额 ÷ 剩余仓位数 平均分配）
 *
 * ⚠️ 纯模拟；不接入真实下单。暂停与全部平仓是两个独立操作，不混为一谈。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      positionId?: string;
      amount?: number | string;
      value?: number | string;
    };
    const engine = getEnhancedEngine();
    await engine.ensureStarted();
    await engine.autoTrader.ensureStarted();
    await ensureTrendTradeSchema();

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
      // Task 55：机器人账户充值（复用 PaperEngine.deposit——余额/totalDeposited 原子递增，
      // 金额校验与手动盘同规则；充值计入 ROI 本金基数、不算盈利）
      case 'deposit': {
        const amount = Number(body.amount);
        try {
          const r = await paperEngineFor(TREND_TRADE.ACCOUNT_NAME).deposit(amount);
          return NextResponse.json({ ok: true, ...r });
        } catch (e) {
          // ⚠️ 不用 instanceof PaperError：引擎单例可能由其它路由图创建（Turbopack 多模块图，
          // 跨图类身份不同——见 paper.ts 全局单例注释）。deposit 只抛校验类错误（文案含 USDT）。
          const msg = e instanceof Error ? e.message : '';
          if (msg.includes('USDT')) {
            return NextResponse.json({ ok: false, error: msg }, { status: 400 });
          }
          return NextResponse.json({ ok: false, error: msg || '充值失败' }, { status: 500 });
        }
      }
      // Task 55：可选持仓数量（最大同时持仓数）——更换时自动平仓原有持仓（用户定版：
      // 旧仓按旧口径开出，换数量即清场，新仓按新数量均分开仓）。同值不动作。
      case 'setMaxPositions': {
        const value = Number(body.value);
        if (
          !Number.isInteger(value) ||
          !TREND_TRADE.MAX_POSITIONS_OPTIONS.includes(value as (typeof TREND_TRADE.MAX_POSITIONS_OPTIONS)[number])
        ) {
          return NextResponse.json(
            {
              ok: false,
              error: `持仓数量须为以下之一：${TREND_TRADE.MAX_POSITIONS_OPTIONS.join(' / ')}`,
            },
            { status: 400 },
          );
        }
        await ensureTrendTradeSchema();
        const current = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
        if (current && current.maxPositions === value) {
          return NextResponse.json({
            ok: true,
            maxPositions: value,
            closed: 0,
            skipped: 0,
            note: `持仓数量已是 ${value}，未做变更`,
          });
        }
        // 先自动平仓原有持仓（先平后开：被平仓的旧趋势周期不会立即重开，新仓只来自新确认周期）
        const closed = await engine.autoTrader.closeAllManual();
        await trendTradeRepo.updateMaxPositions(TREND_TRADE.ACCOUNT_NAME, value);
        return NextResponse.json({
          ok: true,
          maxPositions: value,
          closed: closed.closed,
          skipped: closed.skipped,
          note: `持仓数量已设为 ${value}；已自动平仓 ${closed.closed} 笔原持仓${
            closed.skipped > 0 ? `（${closed.skipped} 笔暂时未能平仓，将在下轮巡检重试）` : ''
          }。每仓保证金改为「可用余额 ÷ 剩余仓位数」均分，新确认趋势按新口径开仓`,
        });
      }
      default:
        return NextResponse.json(
          { ok: false, error: `未知操作：${body.action ?? '(空)'}；支持 start/pause/resume/closeAll/close/deposit/setMaxPositions` },
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
