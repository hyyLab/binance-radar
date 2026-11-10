// ---------- PA 整合 · UTE × PA 多周期协同引擎（任务书 §六，核心新增） ----------
// 目标：区分 ①方向一致 ②正常趋势回调 ③真正结构性冲突 ④信息不足——四态判定。
// 纪律：
// - 保留两套系统原始判断：UTE 原始信号与 PA 原始诊断全量随分析记录留档，本模块
//   绝不因分歧修改任何一方输出；
// - 结构性冲突必须有可追溯的具体证据（evidences 逐条留档），不能仅凭一次方向不一致；
// - 正常回调绝不映射为反向开仓（PULLBACK_DIVERGENCE 只能 WAIT）；
// - AI 不越权：本函数为纯程序规则，AI 输出只是其输入之一。

import type { CoordinationInput, CoordinationResult, CoordinationState } from './types';

/** PA 周期形态分类（Brooks 频谱 → 结构语义分组） */
const TREND_WITH = new Set(['micro_channel', 'tight_channel', 'normal_channel']); // 强趋势形态
const TREND_LOOSE = new Set(['broad_channel', 'trending_tr']); // 弱趋势/斜区间形态
const RANGE_FORMS = new Set(['trading_range', 'extreme_tr']);
const UNREADABLE = new Set(['unknown', '']);

/** 协同置信度门槛：低于此值视为信息不足 → UNCERTAIN */
export const PA_MIN_DIAG_CONFIDENCE = 45;

function paDirToTrend(d: 'bullish' | 'bearish' | 'neutral'): 'up' | 'down' | 'flat' {
  return d === 'bullish' ? 'up' : d === 'bearish' ? 'down' : 'flat';
}

export function coordinate(input: CoordinationInput): CoordinationResult {
  const { ute, pa } = input;
  const ev: string[] = [];
  const mk = (state: CoordinationState, reason: string): CoordinationResult => ({
    state,
    decision: state === 'ALIGNED' ? 'ALLOW' : state === 'STRUCTURAL_CONFLICT' ? 'REJECT' : 'WAIT',
    evidences: ev,
    reason,
  });

  // ── 0. 前置：UTE 必须是确认趋势（扫描层已过滤，此处兜底） ──
  if (ute.direction !== 'up' && ute.direction !== 'down') {
    ev.push(`UTE 方向=${ute.direction}（非确认趋势）`);
    return mk('UNCERTAIN', 'UTE 无有效方向，保留观察不生成交易计划');
  }
  const uteUp = ute.direction === 'up';
  const uteWith = uteUp ? '多头' : '空头';
  ev.push(`UTE ${uteWith}确认趋势 phase=${ute.phase} score=${ute.score.toFixed(0)} cycle=${ute.trendCycleId ?? '-'}`);

  // ── 1. PA 数据完整性 ──
  const diag = pa.diagnosis;
  if (!diag) {
    ev.push('PA 5m 主诊断缺失');
    return mk('UNCERTAIN', 'PA 主诊断缺失，等待重新分析');
  }
  if (!diag.gate_result.pass) {
    ev.push(`PA 诊断闸门未过：${diag.gate_result.reason}`);
    return mk('UNCERTAIN', `PA 认为市场不可读（${diag.gate_result.reason}），等待`);
  }
  if (diag.diagnosis_confidence < PA_MIN_DIAG_CONFIDENCE) {
    ev.push(`PA 诊断置信度 ${diag.diagnosis_confidence} < 门槛 ${PA_MIN_DIAG_CONFIDENCE}`);
    return mk('UNCERTAIN', 'PA 诊断置信度不足，等待');
  }
  const paDir = paDirToTrend(diag.direction);
  ev.push(`PA 5m：${diag.cycle_position}/${diag.direction}（置信度 ${diag.diagnosis_confidence}）AlwaysIn=${diag.direction}`);

  if (paDir === 'flat') {
    ev.push('PA 方向偏好 neutral（无可评估方向）');
    return mk('UNCERTAIN', 'PA 方向中性，等待结构明朗');
  }

  const paWithUte = paDir === ute.direction;
  const paCycle = diag.cycle_position.toLowerCase();
  const structureStillTrendWithUte =
    (paWithUte && (TREND_WITH.has(paCycle) || TREND_LOOSE.has(paCycle))) ||
    // PA 方向虽短期反向，但形态归类仍是顺 UTE 的趋势通道（回调语境）
    (!paWithUte && (TREND_WITH.has(paCycle) || TREND_LOOSE.has(paCycle)));

  // ── 2. 15m 背景（缺失/矛盾的处理在分支内） ──
  const htf = pa.htf;
  let htfDir: 'up' | 'down' | 'flat' | null = null;
  let htfSupportsUte: boolean | null = null; // null = 背景缺失或不可读
  if (htf && htf.gate_result.pass && htf.diagnosis_confidence >= PA_MIN_DIAG_CONFIDENCE) {
    htfDir = paDirToTrend(htf.direction);
    htfSupportsUte = htfDir === 'flat' ? null : htfDir === ute.direction;
    ev.push(`PA 15m 背景：${htf.cycle_position}/${htf.direction}（置信度 ${htf.diagnosis_confidence}）`);
  } else {
    ev.push('PA 15m 背景缺失或不可读（不作为判定依据）');
  }

  // ── 3. 分支判定 ──

  // 3a. PA 与 UTE 同向
  if (paWithUte) {
    if (htfSupportsUte === false) {
      // 5m 同向但 15m 明确反向：不满足 ALIGNED 的 15m 条件；也不足以判定结构反转
      //（5m 结构仍顺 UTE）——按任务书保守原则等待 15m 结构明朗
      ev.push('5m 与 UTE 同向，但 15m 背景明确反向');
      return mk('UNCERTAIN', '5m 同向但高周期背景反向，等待高周期结构明朗（不开仓）');
    }
    if (RANGE_FORMS.has(paCycle) || UNREADABLE.has(paCycle)) {
      ev.push(`PA 形态=${diag.cycle_position}（区间/不可读，趋势质量不足）`);
      return mk('UNCERTAIN', 'PA 同向但形态为区间/不可读，等待趋势形态确认');
    }
    if (diag.market_phase === 'transitioning') {
      ev.push('PA 市场阶段=transitioning（形态切换中）');
      return mk('UNCERTAIN', 'PA 判断市场形态正在切换，等待稳定');
    }
    // 追高潮防线（PA 硬禁令 2）：spike/climax 末端禁追
    const climax = /spike|climax|高潮/i.test(paCycle) ||
      diag.detected_patterns.some((p) => /climax|高潮|尖峰/i.test(p)) ||
      diag.key_signals.some((s) => /climax|高潮|尖峰/i.test(s));
    if (climax) {
      ev.push('PA 提示高潮/尖峰特征（禁追原方向，只允许回撤顺势）');
      return mk('UNCERTAIN', 'PA 识别高潮/尖峰，禁追；等待回撤结构');
    }
    ev.push('UTE 与 PA 5m 同向，15m 背景未反对，趋势形态成立');
    return mk('ALIGNED', `UTE ${uteWith}与 PA 价格行为一致（${diag.cycle_position}），允许生成交易计划（仍需入场位与风险校验）`);
  }

  // 3b. PA 与 UTE 反向 —— 区分「正常回调」与「结构性冲突」（任务书 §6.2-B/C 重点）
  const reverseLabel = uteUp ? '空头' : '多头';
  const conflictConfirmations: string[] = [];
  if (htfSupportsUte === false) {
    conflictConfirmations.push(`15m 背景明确反向（${htf?.direction}/${htf?.cycle_position}，置信度 ${htf?.diagnosis_confidence}）`);
  }
  if (RANGE_FORMS.has(paCycle) || UNREADABLE.has(paCycle)) {
    // 区间形态本身不构成结构性反转证据（区间内反向是常态）
    ev.push(`PA 形态=${diag.cycle_position}（区间语境的反向，倾向回调/震荡处理）`);
  } else if (!structureStillTrendWithUte) {
    conflictConfirmations.push(`PA 5m 形态=${diag.cycle_position} 已非顺 UTE 趋势形态`);
  }
  // Always In 明确反向 = PA direction 反向且置信度高（≥70）
  if (diag.diagnosis_confidence >= 70) {
    conflictConfirmations.push(`PA Always In 明确${reverseLabel}（置信度 ${diag.diagnosis_confidence}）`);
  }
  // 逐K证据：最近 K 线出现趋势级反向棒（趋势阴线/趋势阳线连续）
  const recentTrendBars = diag.bar_by_bar_summary.filter((b) =>
    uteUp ? /趋势阴线/.test(b.reason) || / bear /i.test(b.reason) : /趋势阳线/.test(b.reason) || / bull /i.test(b.reason),
  );
  if (recentTrendBars.length >= 2) {
    conflictConfirmations.push(`逐K证据：${recentTrendBars.length} 根趋势级反向棒（${recentTrendBars.map((b) => b.bar).join(',')}）`);
  }

  if (conflictConfirmations.length >= 2) {
    // 结构性冲突：多项独立证据（形态脱离 + 15m 反向 / 高置信 Always In 反向 / 反向趋势棒）
    ev.push(`结构性冲突确认（${conflictConfirmations.length} 项独立证据）：${conflictConfirmations.join('；')}`);
    return mk(
      'STRUCTURAL_CONFLICT',
      `UTE ${uteWith}计划被拒绝：PA 价格行为出现结构性${reverseLabel}证据（${conflictConfirmations.length} 项），进入冷却等待新趋势`,
    );
  }

  // 回调型分歧：UTE 仍顺、PA 短期反向、但结构未破坏（15m 背景仍支持 / 形态仍属顺向趋势通道 / 证据不足 2 项）
  ev.push(`回调型分歧：PA 5m 短期${reverseLabel}行为，但结构破坏证据不足（${conflictConfirmations.length} 项：${conflictConfirmations.join('；') || '无'}）`);
  if (htfSupportsUte === true) {
    ev.push('15m 背景仍支持 UTE 原方向');
  }
  return mk(
    'PULLBACK_DIVERGENCE',
    `UTE ${uteWith}中的正常回调判定：不反向开仓、不追价，放入等待队列跟踪后续 5m 收盘（回调结束需新的价格行为证据）`,
  );
}
