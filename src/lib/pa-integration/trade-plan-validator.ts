// ---------- PA 整合 · 交易计划程序化校验器（任务书 §7.3） ----------
// trade_metrics.py 的 TS 移植（compute_risk_reward / passes_trader_equation /
// validate_take_profit_2_geometry / limit-order K1 freshness），叠加任务书 §7.3 十三项检查。
//
// ⚠️ 与 PA 原版的明确偏差（任务书红线 9）：PA 原版 adjust_decision_stop_for_tp1_rr_cap
// 会在 TP1 盈亏比超 1 时【自动加宽止损】——本整合禁止该行为：原始结构止损不合理 →
// 直接拒绝计划并记录原因，绝不擅自修改 AI 输出的风险边界。
// ⚠️ estimated_win_rate 是模型估计值，不是真实历史胜率（展示与留档均须带此标注）。

import type { PaRawPlan, PaTradePlan, PaValidationCheck } from './types';

export interface ValidatorCtx {
  /** 最新已收盘 5m K 线（limit-order 新鲜度检查） */
  last5m: { open: number; high: number; low: number; close: number; ts: number } | null;
  /** 当前标记价（入场偏离检查） */
  mark: number;
  tickSize: number;
  minRiskReward: number;
  maxEntryDeviationPct: number;
  /** 计划依据的 5m bar（数据新鲜度） */
  barTime5m: number;
  now: number;
  /** 方向与协同是否一致（check 1/2） */
  uteDirection: 'up' | 'down' | 'flat' | null;
  coordinationState: string;
  analysisAgeMs: number;
  maxAnalysisAgeMs: number;
}

function isLong(d: PaRawPlan['direction'] | null): boolean | null {
  if (d === 'LONG') return true;
  if (d === 'SHORT') return false;
  return null;
}

/** compute_risk_reward 移植：方向已知时按方向算；返回 null = 无效几何 */
export function computeRiskReward(
  entry: number,
  takeProfit: number,
  stopLoss: number,
  direction: PaRawPlan['direction'] | null,
): { risk: number; reward: number; ratio: number } | null {
  const long = isLong(direction);
  let risk: number;
  let reward: number;
  if (long === true) {
    risk = entry - stopLoss;
    reward = takeProfit - entry;
  } else if (long === false) {
    risk = stopLoss - entry;
    reward = entry - takeProfit;
  } else {
    if (takeProfit > entry && stopLoss < entry) {
      risk = entry - stopLoss;
      reward = takeProfit - entry;
    } else if (takeProfit < entry && stopLoss > entry) {
      risk = stopLoss - entry;
      reward = entry - takeProfit;
    } else {
      return null;
    }
  }
  if (risk <= 0 || reward <= 0) return null;
  return { risk, reward, ratio: reward / risk };
}

/** Brooks 交易者方程：win_rate × reward > (1 − win_rate) × risk（estimated_win_rate 为模型估计） */
export function passesTraderEquation(winRatePct: number, risk: number, reward: number): boolean {
  if (risk <= 0 || reward <= 0) return false;
  const p = Math.max(0, Math.min(100, winRatePct)) / 100;
  return p * reward > (1 - p) * risk;
}

/** tick 对齐检查（tickSize 缺失时跳过并如实说明） */
function tickAligned(price: number, tick: number): boolean | null {
  if (!(tick > 0)) return null;
  const scaled = price / tick;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

function check(id: string, label: string, passed: boolean, detail: string): PaValidationCheck {
  return { id, label, passed, detail };
}

/**
 * 全量校验（任务书 §7.3 十三项 + PA 原版几何/交易者方程）。
 * 返回 null = 拒绝（checks 带全部失败明细）；返回 PaTradePlan = 通过。
 * 绝不修改输入计划的价格字段（红线 9）。
 */
export function validatePlan(plan: PaRawPlan, ctx: ValidatorCtx): { plan: PaTradePlan | null; checks: PaValidationCheck[] } {
  const checks: PaValidationCheck[] = [];
  const fail = (c: PaValidationCheck): { plan: null; checks: PaValidationCheck[] } => {
    checks.push(c);
    return { plan: null, checks };
  };

  // 1) 方向与 UTE 一致
  const planIsLong = plan.direction === 'LONG';
  const uteIsLong = ctx.uteDirection === 'up';
  if (ctx.uteDirection == null || planIsLong !== uteIsLong) {
    return fail(check('DIR_MATCH', '交易方向与 UTE 方向一致', false, `计划=${plan.direction} UTE=${ctx.uteDirection ?? '-'}`));
  }
  checks.push(check('DIR_MATCH', '交易方向与 UTE 方向一致', true, `计划=${plan.direction} UTE=${ctx.uteDirection}`));

  // 2) 协同状态为 ALIGNED
  if (ctx.coordinationState !== 'ALIGNED') {
    return fail(check('COORD_ALIGNED', '协同状态为 ALIGNED', false, `当前协同=${ctx.coordinationState}`));
  }
  checks.push(check('COORD_ALIGNED', '协同状态为 ALIGNED', true, '已通过协同引擎'));

  // 3) PA 诊断与 K 线数据未过期
  if (ctx.analysisAgeMs > ctx.maxAnalysisAgeMs) {
    return fail(check('FRESH', 'PA 诊断与 K 线数据未过期', false, `分析年龄 ${(ctx.analysisAgeMs / 60_000).toFixed(1)}min > 上限 ${(ctx.maxAnalysisAgeMs / 60_000).toFixed(1)}min`));
  }
  checks.push(check('FRESH', 'PA 诊断与 K 线数据未过期', true, `分析年龄 ${(ctx.analysisAgeMs / 60_000).toFixed(1)}min`));

  // 4) 四价均为有效正数
  const prices = { entry: plan.entryPrice, sl: plan.stopLoss, tp1: plan.takeProfit1, tp2: plan.takeProfit2 };
  for (const [k, v] of Object.entries(prices)) {
    if (v == null || !Number.isFinite(v) || v <= 0) {
      return fail(check('PRICES_POSITIVE', '入场/止损/TP1/TP2 均为有效正数', false, `${k}=${String(v)}`));
    }
  }
  checks.push(check('PRICES_POSITIVE', '入场/止损/TP1/TP2 均为有效正数', true, `entry=${plan.entryPrice} sl=${plan.stopLoss} tp1=${plan.takeProfit1} tp2=${plan.takeProfit2}`));

  const entry = plan.entryPrice!;
  const sl = plan.stopLoss!;
  const tp1 = plan.takeProfit1!;
  const tp2 = plan.takeProfit2!;
  const long = plan.direction === 'LONG';

  // 5/6) 几何关系（PA 原版 validate_take_profit_2_geometry 同口径：stop<entry<TP1<TP2 / 反向）
  const geoOk = long ? sl < entry && entry < tp1 && tp1 < tp2 : tp2 < tp1 && tp1 < entry && entry < sl;
  if (!geoOk) {
    return fail(check('GEOMETRY', long ? '多头几何 stop < entry < TP1 < TP2' : '空头几何 TP2 < TP1 < entry < stop', false, `sl=${sl} entry=${entry} tp1=${tp1} tp2=${tp2}`));
  }
  checks.push(check('GEOMETRY', long ? '多头几何 stop < entry < TP1 < TP2' : '空头几何 TP2 < TP1 < entry < stop', true, '通过'));

  // 7) tickSize 对齐（缺失则跳过，如实说明）
  for (const [k, v] of [['entry', entry], ['sl', sl], ['tp1', tp1], ['tp2', tp2]] as const) {
    const aligned = tickAligned(v, ctx.tickSize);
    if (aligned === false) {
      return fail(check('TICK_SIZE', '价格符合交易所 tickSize', false, `${k}=${v} 与 tickSize=${ctx.tickSize} 不对齐`));
    }
  }
  checks.push(check('TICK_SIZE', '价格符合交易所 tickSize', true, ctx.tickSize > 0 ? `tickSize=${ctx.tickSize}` : 'tickSize 未知（跳过对齐检查）'));

  // 8) 真实风险收益比达到配置要求（禁自动加宽——不足即拒）
  const rr1 = computeRiskReward(entry, tp1, sl, plan.direction);
  if (!rr1) {
    return fail(check('RR_MIN', '风险收益比达到配置要求', false, '几何无效（risk/reward 非正）'));
  }
  if (rr1.ratio < ctx.minRiskReward) {
    return fail(check('RR_MIN', '风险收益比达到配置要求', false, `TP1 盈亏比 ${rr1.ratio.toFixed(2)} < 下限 ${ctx.minRiskReward}（红线 9：不自动加宽止损，直接拒绝）`));
  }
  checks.push(check('RR_MIN', '风险收益比达到配置要求', true, `TP1 盈亏比 ${rr1.ratio.toFixed(2)} ≥ ${ctx.minRiskReward}`));

  // 9) TP2 几何正确（PA 原版：TP2 在 TP1 利润方向之外；无 RR 上限）
  const rr2 = computeRiskReward(entry, tp2, sl, plan.direction);
  if (!rr2 || rr2.ratio <= rr1.ratio) {
    return fail(check('TP2_GEOMETRY', 'TP2 几何关系正确（TP2 在 TP1 之外）', false, `TP2 盈亏比 ${rr2 ? rr2.ratio.toFixed(2) : '无效'} 应大于 TP1 ${rr1.ratio.toFixed(2)}`));
  }
  checks.push(check('TP2_GEOMETRY', 'TP2 几何关系正确（TP2 在 TP1 之外）', true, `TP2 盈亏比 ${rr2.ratio.toFixed(2)}`));

  // 10) 交易者方程（estimated_win_rate 为模型估计值，非真实胜率）
  if (plan.estimatedWinRate == null) {
    return fail(check('TRADER_EQ', '交易者方程（Brooks expectancy）', false, 'estimated_win_rate 缺失'));
  }
  if (!passesTraderEquation(plan.estimatedWinRate, rr1.risk, rr1.reward)) {
    const ev = (plan.estimatedWinRate / 100) * rr1.reward - (1 - plan.estimatedWinRate / 100) * rr1.risk;
    return fail(check('TRADER_EQ', '交易者方程（Brooks expectancy）', false, `估计胜率 ${plan.estimatedWinRate}% 期望≈${ev.toFixed(4)} ≤ 0（模型估计值，非真实胜率）`));
  }
  checks.push(check('TRADER_EQ', '交易者方程（Brooks expectancy）', true, `估计胜率 ${plan.estimatedWinRate}%（模型估计值，非真实胜率）`));

  // 11) 限价单未过期且未错过入场位（PA 原版 K1 freshness 移植）
  if (plan.orderType === 'LIMIT' && ctx.last5m) {
    const k = ctx.last5m;
    const staleLong = long && (k.low <= entry + ctx.tickSize || k.close < entry - ctx.tickSize);
    const staleShort = !long && (k.high >= entry - ctx.tickSize || k.close > entry + ctx.tickSize);
    if (staleLong || staleShort) {
      return fail(check('LIMIT_FRESH', '限价单未错过入场位（K1 freshness）', false, `K1 H=${k.high} L=${k.low} C=${k.close} vs entry=${entry}`));
    }
    checks.push(check('LIMIT_FRESH', '限价单未错过入场位（K1 freshness）', true, `K1 H=${k.high} L=${k.low} C=${k.close}`));
  } else if (plan.orderType === 'LIMIT') {
    checks.push(check('LIMIT_FRESH', '限价单未错过入场位（K1 freshness）', true, '无 K1 数据（跳过——上游数据检查已拦截）'));
  } else {
    checks.push(check('LIMIT_FRESH', '限价单未错过入场位（K1 freshness）', true, `订单类型=${plan.orderType}（不适用）`));
  }

  // 12) 当前价格偏离在允许范围内
  const devPct = Math.abs(ctx.mark - entry) / entry * 100;
  if (devPct > ctx.maxEntryDeviationPct) {
    return fail(check('DEVIATION', '当前价格偏离在允许范围内', false, `偏离 ${devPct.toFixed(3)}% > 上限 ${ctx.maxEntryDeviationPct}%（mark=${ctx.mark} entry=${entry}）`));
  }
  checks.push(check('DEVIATION', '当前价格偏离在允许范围内', true, `偏离 ${devPct.toFixed(3)}% ≤ ${ctx.maxEntryDeviationPct}%`));

  // 13) 方向与订单类型语义一致（突破单触发价应在顺方向；限价单在回撤方向）——结构性语义检查
  if (plan.orderType === 'STOP_MARKET') {
    const wrongSide = long ? entry <= ctx.mark : entry >= ctx.mark;
    if (wrongSide) {
      return fail(check('ORDER_SEMANTIC', '订单类型与价格语义一致', false, `突破单 ${plan.direction} 触发价 ${entry} 应在市价 ${ctx.mark} 的${long ? '上方' : '下方'}`));
    }
    checks.push(check('ORDER_SEMANTIC', '订单类型与价格语义一致', true, `突破单触发价 ${entry} ${long ? '>' : '<'} 市价 ${ctx.mark}`));
  } else if (plan.orderType === 'LIMIT') {
    const wrongSide = long ? entry >= ctx.mark : entry <= ctx.mark;
    if (wrongSide) {
      return fail(check('ORDER_SEMANTIC', '订单类型与价格语义一致', false, `限价单 ${plan.direction} 挂单价 ${entry} 应在市价 ${ctx.mark} 的${long ? '下方' : '上方'}（等待回调）`));
    }
    checks.push(check('ORDER_SEMANTIC', '订单类型与价格语义一致', true, `限价挂单价 ${entry} ${long ? '<' : '>'} 市价 ${ctx.mark}`));
  } else {
    checks.push(check('ORDER_SEMANTIC', '订单类型与价格语义一致', true, '市价单（不适用）'));
  }

  // 通过 → 组装最终计划（数值字段已在上面保证非空）
  return {
    plan: {
      ...plan,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit1: tp1,
      takeProfit2: tp2,
      estimatedWinRate: plan.estimatedWinRate,
      rewardRisk: rr1.ratio,
      riskPerUnit: rr1.risk,
      checks,
      barTime5m: ctx.barTime5m,
      promptVersion: '',
      analysisId: '',
    },
    checks,
  };
}
