// ---------- PA 整合 · 策略统计（任务书 §9.4） ----------
// 统计口径与 trend-trade 相同的保守原则：净盈亏 = PaperTrade.pnl 求和（已扣双边手续费），
// 滑点另按 bps 估算展示；estimated 胜率来自实际成交记录，与 AI 估计胜率严格区分。

import { db } from '@/lib/db';
import { PA_ACCOUNT_NAME } from './config';
import { paRepo } from './repo';

export interface PaStats {
  balance: number;
  equity: number;
  realizedPnl: number;
  feePaid: number;
  closedCount: number;
  winRate: number; // 实际成交口径
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldMinutes: number;
  openPositions: number;
  activePendings: number;
}

export async function paStats(): Promise<PaStats> {
  const acc = await db.paperAccount.findUnique({ where: { name: PA_ACCOUNT_NAME } });
  const accId = acc?.id ?? '';
  const CLOSE_ACTIONS = ['CLOSE_LONG', 'CLOSE_SHORT', 'LIQUIDATE'];

  const [trades, closedPositions, openPositions, activePendings] = await Promise.all([
    accId ? db.paperTrade.findMany({ where: { accountId: accId, action: { in: CLOSE_ACTIONS } }, orderBy: { createdAt: 'asc' } }) : [],
    accId ? db.paperPosition.findMany({ where: { accountId: accId, status: { in: ['CLOSED', 'LIQUIDATED'] } } }) : [],
    accId ? db.paperPosition.findMany({ where: { accountId: accId, status: 'OPEN' } }) : [],
    paRepo.loadPendingOrders('ACTIVE'),
  ]);

  const realizedPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const feePaid = trades.reduce((s, t) => s + t.fee, 0);
  const wins = closedPositions.filter((p) => (p.pnl ?? 0) > 0);
  const losses = closedPositions.filter((p) => (p.pnl ?? 0) <= 0);
  const grossWin = wins.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + (p.pnl ?? 0), 0));

  // 最大回撤：按平仓流水累计权益曲线（简化口径：基于 closedPositions pnl 序列）
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  const sorted = [...closedPositions].sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
  for (const p of sorted) {
    cum += p.pnl ?? 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  const holdMinutes =
    closedPositions.length > 0
      ? closedPositions.reduce((s, p) => {
          const open = p.openedAt instanceof Date ? p.openedAt.getTime() : Number(p.openedAt);
          const close = p.closedAt instanceof Date ? p.closedAt.getTime() : Number(p.closedAt ?? open);
          return s + (close - open) / 60_000;
        }, 0) / closedPositions.length
      : 0;

  const balance = acc?.balance ?? 0;
  const unrealized = openPositions.reduce((s, p) => {
    return s; // 未实现盈亏由 pa-trader.overview 提供（需标记价）；此处只统计已实现口径
  }, 0);
  void unrealized;

  return {
    balance,
    equity: balance,
    realizedPnl,
    feePaid,
    closedCount: closedPositions.length,
    winRate: closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownPct: balance > 0 ? (maxDd / balance) * 100 : 0,
    avgHoldMinutes: holdMinutes,
    openPositions: openPositions.length,
    activePendings: activePendings.length,
  };
}
