import { NextResponse } from 'next/server';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { paperEngineFor } from '@/lib/market/paper';
import { ensureTrendTradeSchema, trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { isKnownStrategy } from '@/lib/market/trend-trade/strategy/registry';
import { sanitizeRuntimeParams } from '@/lib/market/trend-trade/console-params';

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
 *   原有持仓。Task 56 sizing：每仓保证金 = 开仓时账户权益 × 20%，与持仓数量解耦，
 *   持仓数量仅约束同时持仓上限）
 * - reset    ：重置机器人账户（Task 55：按标记价平掉全部持仓并清空持仓/流水/趋势关联
 *   与决策审计，资金回到初始 100 USDT、ROI 本金基准归零；运行模式与持仓数量保持不变）
 * - setStrategy：切换交易算法（Task 57：先自动平仓清场——不同算法持仓管理规则不同，
 *   不混管；再持久化 strategyId 并热切换策略实例。同值不动作）
 * - setRuntimeParams：保存参数控制台（Task 57-c：策略门槛/时机/轮次/冲高套利/冷却/
 *   二次确认开关；严格校验后持久化并热生效——策略参数重装配实例，轮次状态保留）
 * - resetRuntimeParams：恢复全部控制台参数为代码默认（清覆盖 + 二次确认回开 + 冷却回默认）
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
      params?: Record<string, unknown>;
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
          }。每仓保证金 = 开仓时账户权益 × 20%（与持仓数量解耦，余额不足时跳过并记录）`,
        });
      }
      // Task 55：重置机器人账户——先按标记价正常平掉全部持仓，再清空持仓/流水/趋势
      // 关联与决策审计；资金回到初始 100 USDT（totalDeposited 归零，ROI 本金基准 = 100）。
      // ⚠️ 破坏性操作：前端弹窗二次确认后才调用；手动盘 default 账户完全不受影响。
      case 'reset': {
        const r = await engine.autoTrader.resetAccount();
        return NextResponse.json({
          ok: true,
          closed: r.closed,
          balance: TREND_TRADE.INITIAL_CAPITAL,
          note: `机器人账户已重置：资金回到 ${TREND_TRADE.INITIAL_CAPITAL} USDT，已按标记价平掉 ${r.closed} 笔持仓并清空全部历史交易与决策审计（运行模式与持仓数量保持不变）`,
        });
      }
      // Task 57：切换交易算法——先平仓清场（不同算法持仓管理规则不同），再热切换策略
      // 实例（持久化 strategyId + 恢复该策略的轮次状态）。同值不动作。
      case 'setStrategy': {
        const value = String(body.value ?? '');
        if (!isKnownStrategy(value)) {
          return NextResponse.json({ ok: false, error: `未知算法：${value}` }, { status: 400 });
        }
        await ensureTrendTradeSchema();
        const current = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
        if (current?.strategyId === value) {
          return NextResponse.json({
            ok: true,
            strategyId: value,
            closed: 0,
            skipped: 0,
            note: `当前算法已是 ${value}，未做变更`,
          });
        }
        // 先自动平仓清场（不同算法离场规则不同，持仓不由新算法接管管理）
        const closed = await engine.autoTrader.closeAllManual();
        await engine.autoTrader.setStrategyId(value);
        return NextResponse.json({
          ok: true,
          strategyId: value,
          closed: closed.closed,
          skipped: closed.skipped,
          note: `算法已切换为 ${value}；已自动平仓 ${closed.closed} 笔原持仓${
            closed.skipped > 0 ? `（${closed.skipped} 笔暂时未能平仓，将在下轮巡检重试）` : ''
          }。新开仓由新算法按其规则决策（待入场记录已随清场失效）`,
        });
      }
      // Task 57-c：参数控制台——严格校验（白名单/类型/范围，错误原样返回给用户）后
      // 持久化并热生效：策略参数重装配实例（轮次状态从 DB 恢复），基础设施参数下一 tick 生效
      case 'setRuntimeParams': {
        let sanitized;
        try {
          sanitized = sanitizeRuntimeParams(body.params);
        } catch (e) {
          return NextResponse.json(
            { ok: false, error: e instanceof Error ? e.message : '参数校验失败' },
            { status: 400 },
          );
        }
        await engine.autoTrader.setRuntimeParams({
          strategyParams: sanitized.strategyParams as Record<string, unknown>,
          waitBarConfirm: sanitized.waitBarConfirm,
          cooldownMs: sanitized.cooldownMs,
        });
        return NextResponse.json({
          ok: true,
          note: '参数已保存并即时生效（无需重启；轮次状态保留）。1m 趋势确认固定需 3 根已收盘 K 线，不在可调范围。',
        });
      }
      // Task 57-c：恢复全部控制台参数为代码默认
      case 'resetRuntimeParams': {
        await engine.autoTrader.resetRuntimeParams();
        return NextResponse.json({
          ok: true,
          note: '已恢复全部参数为代码默认值（二次确认回开、冷却回默认；轮次状态保留）',
        });
      }
      default:
        return NextResponse.json(
          { ok: false, error: `未知操作：${body.action ?? '(空)'}；支持 start/pause/resume/closeAll/close/deposit/setMaxPositions/setStrategy/setRuntimeParams/resetRuntimeParams/reset` },
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
