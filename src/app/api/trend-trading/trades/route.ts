import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { trendTradeRepo, type TrendTradeMetaRow } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { DEFAULT_STRATEGY_ID, listStrategies } from '@/lib/market/trend-trade/strategy/registry';

export const dynamic = 'force-dynamic';

/**
 * 趋势自动模拟交易 · 历史明细（Task 54 §5.3）
 * GET /api/trend-trading/trades?symbol=BTC&limit=100&sort=pnl|time&order=asc|desc
 * GET /api/trend-trading/trades?positionId=xxx   （单笔详情：还原决策链）
 *
 * 返回每笔已平仓交易的完整口径：开/平仓价、滑点估算、毛盈亏/净盈亏/
 * 含滑点净盈亏、开仓算法（Task 63：历史明细「算法」列，费用不再展示）、
 * 开仓与退出时的趋势状态及理由、平仓原因、趋势周期关联。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const positionId = url.searchParams.get('positionId');

    // —— 单笔详情：meta + 仓位 + 该趋势周期的全部决策（决策链还原） ——
    if (positionId) {
      const meta = await trendTradeRepo.getMeta(positionId);
      if (!meta) {
        return NextResponse.json(
          { ok: false, error: '未找到该笔交易的趋势关联' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const pos = await db.paperPosition.findUnique({ where: { id: positionId } });
      const decisions = await db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT id, symbol, action, cycleId, positionId, detail, createdAt
         FROM TrendAutoDecision WHERE cycleId = ? ORDER BY createdAt ASC`,
        meta.trendCycleId,
      );
      return NextResponse.json(
        {
          ok: true,
          detail: {
            meta,
            position: pos,
            decisions: decisions.map((d) => ({
              id: String(d.id),
              action: String(d.action),
              cycleId: String(d.cycleId),
              detail: String(d.detail ?? '{}'),
              createdAt: d.createdAt instanceof Date ? d.createdAt.getTime() : Number(d.createdAt),
            })),
          },
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // —— 列表 ——
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (!acc) {
      return NextResponse.json(
        { ok: true, ts: Date.now(), trades: [] },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    const sort = url.searchParams.get('sort') === 'pnl' ? 'pnl' : 'time';
    const order = url.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));

    // Task 63：算法 id → 展示名映射（registry 唯一真值，与 UI 算法下拉同源）。
    // 历史行无独立 strategyId 列：开仓算法自 Task 57 起随 executeOpen 写进
    // featuresAtOpen 快照 JSON（featuresAtOpen.strategyId），更早/缺失一律兜底
    // 默认算法（short-swing-v1 在 Task 62 前是唯一在线算法，事实正确）。
    const strategyNameById = new Map(listStrategies().map((s) => [s.id, s.name] as const));

    const closedMetas: TrendTradeMetaRow[] = await trendTradeRepo.loadMetasByStatus('CLOSED');
    const rows: Record<string, unknown>[] = [];
    for (const m of closedMetas) {
      if (symbol && !m.symbol.includes(symbol)) continue;
      const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
      if (!pos) continue;
      // 开仓算法：featuresAtOpen.strategyId（Task 57 起快照）；损坏/缺失兜底默认算法
      let strategyId = DEFAULT_STRATEGY_ID;
      try {
        strategyId = (JSON.parse(m.featuresAtOpen) as { strategyId?: string }).strategyId ?? DEFAULT_STRATEGY_ID;
      } catch {
        /* 快照损坏 → 默认算法 */
      }
      rows.push({
        positionId: m.positionId,
        symbol: m.symbol,
        base: m.symbol.replace(/USDT$/, ''),
        side: m.side,
        strategyId,
        strategyName: strategyNameById.get(strategyId) ?? strategyId,
        // —— 时间 ——
        openedAt: pos.openedAt.toISOString(),
        closedAt: (pos.closedAt ?? m.closedAt ? new Date(m.closedAt ?? Date.now()) : new Date()).toISOString(),
        holdMinutes:
          pos.closedAt != null
            ? Math.max(0, Math.round((pos.closedAt.getTime() - pos.openedAt.getTime()) / 60_000))
            : null,
        // —— 价格与仓位 ——
        entryPrice: pos.entryPrice,
        exitPrice: pos.exitPrice,
        margin: pos.margin,
        leverage: pos.leverage,
        notionalOpen: pos.qty * pos.entryPrice,
        // —— 成本与盈亏（多口径并列；主口径 = 含滑点净盈亏）——
        grossPnl:
          pos.exitPrice != null
            ? (pos.exitPrice - pos.entryPrice) * pos.qty * (pos.side === 'LONG' ? 1 : -1)
            : null,
        openFee: pos.openFee,
        closeFee: pos.closeFee,
        slippageEst: m.slippageEst,
        netPnl: pos.pnl, // 手续费后净盈亏（PaperEngine 口径）
        netPnlWithSlip: m.netPnlWithSlip, // 再扣双边滑点估算（统计主口径）
        // —— 趋势关联 ——
        trendCycleId: m.trendCycleId,
        trendPhaseAtOpen: m.trendPhaseAtOpen,
        scoreAtOpen: m.scoreAtOpen,
        exitReason: pos.status === 'LIQUIDATED' ? 'LIQUIDATED' : m.exitReason,
        exitSignal: m.exitSignalJson ? JSON.parse(m.exitSignalJson) : null,
        signalAtOpen: m.signalAtOpen ? JSON.parse(m.signalAtOpen) : null,
      });
    }
    rows.sort((a, b) => {
      if (sort === 'pnl') {
        return order === 'ASC'
          ? Number(a.netPnlWithSlip ?? 0) - Number(b.netPnlWithSlip ?? 0)
          : Number(b.netPnlWithSlip ?? 0) - Number(a.netPnlWithSlip ?? 0);
      }
      const ta = new Date(String(a.closedAt)).getTime();
      const tb = new Date(String(b.closedAt)).getTime();
      return order === 'ASC' ? ta - tb : tb - ta;
    });

    return NextResponse.json(
      { ok: true, ts: Date.now(), trades: rows.slice(0, limit) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'trend trades error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
