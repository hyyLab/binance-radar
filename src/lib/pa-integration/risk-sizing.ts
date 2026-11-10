// ---------- PA 整合 · 风险预算仓位计算（任务书 §7.5） ----------
// RiskBudget = AccountEquity × RiskPerTrade%
// PositionQty = RiskBudget / |Entry − StopLoss|
// PositionNotional = Qty × Entry
// RequiredMargin = Notional / Leverage
// 结合 tickSize 取整、最小保证金、余额与总敞口校验——不足即拒绝（不变通放大杠杆）。

import { PAPER_MIN_MARGIN } from '@/lib/market/futures';

export interface RiskSizingInput {
  equity: number; // 账户权益（USDT）
  availableBalance: number; // 可用余额
  entry: number;
  stopLoss: number;
  riskPerTradePct: number;
  maxTotalRiskPct: number;
  /** 当前策略总风险敞口（USDT，= 各持仓 |entry-stop|×qty 之和） */
  currentTotalRisk: number;
  leverage: number;
  leverageCap: number;
  feeRate: number;
  tickSize: number;
}

export interface RiskSizingResult {
  ok: boolean;
  reason: string | null;
  qty: number;
  margin: number;
  notional: number;
  riskAmount: number;
  fee: number;
  leverage: number;
}

function roundQty(q: number, tick: number): number {
  if (!(tick > 0)) return q;
  const step = tick; // 数量精度近似按 tick 对齐（保守向下取整，不放大风险）
  return Math.floor(q / step) * step;
}

export function computeRiskSizing(input: RiskSizingInput): RiskSizingResult {
  const fail = (reason: string): RiskSizingResult => ({
    ok: false, reason, qty: 0, margin: 0, notional: 0, riskAmount: 0, fee: 0, leverage: input.leverage,
  });

  const leverage = Math.min(Math.max(1, Math.floor(input.leverage)), Math.max(1, Math.floor(input.leverageCap)));
  const riskPerUnit = Math.abs(input.entry - input.stopLoss);
  if (!(riskPerUnit > 0)) return fail('止损距离为 0（几何无效）');

  const riskBudget = input.equity * (input.riskPerTradePct / 100);
  if (!(riskBudget > 0)) return fail('权益非正，无法计算风险预算');

  // 总敞口守卫（任务书 §7.5：单策略总风险敞口 ≤ 权益×maxTotalRiskPct）
  const totalRiskCap = input.equity * (input.maxTotalRiskPct / 100);
  if (input.currentTotalRisk + riskBudget > totalRiskCap + 1e-9) {
    return fail(`总风险敞口超限：现有 ${input.currentTotalRisk.toFixed(2)} + 本笔 ${riskBudget.toFixed(2)} > 上限 ${totalRiskCap.toFixed(2)}`);
  }

  let qty = riskBudget / riskPerUnit;
  qty = roundQty(qty, input.tickSize);
  if (!(qty > 0)) return fail(`风险预算 ${riskBudget.toFixed(4)} 不足以买进最小数量单位（tick=${input.tickSize}）`);

  const notional = qty * input.entry;
  const margin = notional / leverage;
  const fee = notional * input.feeRate;
  if (margin + fee > input.availableBalance) {
    return fail(`保证金 ${margin.toFixed(2)} + 手续费 ${fee.toFixed(2)} 超出可用余额 ${input.availableBalance.toFixed(2)}（跳过不变通）`);
  }
  if (margin < PAPER_MIN_MARGIN) {
    return fail(`保证金 ${margin.toFixed(2)} 低于最小保证金 ${PAPER_MIN_MARGIN}`);
  }
  return { ok: true, reason: null, qty, margin, notional, riskAmount: qty * riskPerUnit, fee, leverage };
}

/** 全部 OPEN 持仓的总风险敞口（|entry−stop|×remainingQty 求和） */
export function sumOpenRisk(
  metas: { symbol: string; stopLoss: number; remainingQty: number }[],
  entryBySymbol: (symbol: string) => number,
): number {
  let total = 0;
  for (const m of metas) {
    const entry = entryBySymbol(m.symbol);
    if (entry > 0 && m.stopLoss > 0) {
      total += Math.abs(entry - m.stopLoss) * m.remainingQty;
    }
  }
  return total;
}
