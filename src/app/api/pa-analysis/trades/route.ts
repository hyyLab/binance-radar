// GET /api/pa-analysis/trades —— PA 模拟持仓（含元数据）+ 已平仓交易（统计复盘）

import { db } from '@/lib/db';
import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { paRepo } from '@/lib/pa-integration/repo';
import { liveFuturesMark } from '@/lib/pa-integration/market-snapshot';
import { PA_ACCOUNT_NAME } from '@/lib/pa-integration/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await paApiBoot();
    const acc = await db.paperAccount.findUnique({ where: { name: PA_ACCOUNT_NAME } });
    if (!acc) return Response.json({ ok: true, positions: [], closed: [], trades: [] });

    const [positions, metas, closedRows, trades] = await Promise.all([
      db.paperPosition.findMany({ where: { accountId: acc.id, status: 'OPEN' }, orderBy: { openedAt: 'desc' } }),
      paRepo.loadPositionMetas('OPEN'),
      db.paperPosition.findMany({
        where: { accountId: acc.id, status: { in: ['CLOSED', 'LIQUIDATED'] } },
        orderBy: { closedAt: 'desc' },
        take: 100,
      }),
      db.paperTrade.findMany({ where: { accountId: acc.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    const metaMap = new Map(metas.map((m) => [m.positionId, m]));

    return Response.json({
      ok: true,
      ts: Date.now(),
      account: { name: acc.name, balance: acc.balance, totalDeposited: acc.totalDeposited },
      positions: positions.map((p) => {
        const mark = liveFuturesMark(p.symbol) || p.entryPrice;
        const m = metaMap.get(p.id);
        const upnl = (mark - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
        return {
          positionId: p.id,
          symbol: p.symbol,
          side: p.side,
          leverage: p.leverage,
          margin: p.margin,
          qty: p.qty,
          entryPrice: p.entryPrice,
          markPrice: mark,
          unrealizedPnl: upnl,
          liqPrice: p.liqPrice,
          openedAt: p.openedAt,
          meta: m ?? null,
        };
      }),
      closed: closedRows.map((p) => {
        const m = metaMap.get(p.id);
        return {
          positionId: p.id,
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          exitPrice: p.exitPrice,
          pnl: p.pnl,
          status: p.status,
          openedAt: p.openedAt,
          closedAt: p.closedAt,
          exitReason: m?.exitReason ?? null,
          planId: m?.planId ?? null,
        };
      }),
      trades,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
