// ---------- 趋势生命周期状态机 v2（Task 54 §2.3 / Task 56 重构定版） ----------
// 在 UTE（idle/candidate/confirmed + 同根 K 线去重）之上扩展趋势结束判定：
//   END_PENDING：出现结束迹象，需连续 END_CONFIRM_BARS 根「不同且有效的已收盘 K 线」
//               持续出现证据才判 ENDED（防单根长影线/插针/短暂回撤直接触发离场）；
//               条件恢复（某根 K 线无证据）→ 清零重计（迟滞）。
//   ENDED：终态（记录原因/时间；周期 id 保留到新周期确认为止——持仓按周期匹配离场）；
//   DATA_UNAVAILABLE：数据不可用时冻结判断，绝不伪装为趋势结束。
//
// 方向结论仍唯一来自 UTE assessment——本状态机只管理「生命周期语义」：
//   结束证据 A：UTE 出现反向 candidate（candidateDirection 反向）
//   结束证据 B：动量衰减（方向感知）——趋势方向上的窗口收益 < minMovePct × END_MOMENTUM_RATIO
//              （与入场确认阈值 minMovePct 构成迟滞区间；不再用绝对收益，多空同口径）
//   结束证据 C：结构失效——ER < END_ER_FLOOR 或方向一致性 < END_CONSISTENCY_FLOOR
//   反向趋势达到 UTE confirmed → 立即 ENDED(CONFIRMED_REVERSAL)，不等确认根数
//
// Task 56 P0 修复（用户定版 §2.1/§2.3）：
//   - barTime=null / 未收盘 / 数据不可用：绝不推进任何结束计数（顶层守卫 + 证据级双保险）
//   - 证据幂等键 = symbol(状态内) + trendCycleId(周期创建时清空) + barTime（数组持久化，
//     重启恢复后同一根 K 线不会重复计数；不仅依赖内存 Map）
//   - 周期出生所在的 K 线不得作为该周期的结束证据（barTime 收盘时刻必须晚于周期创建时刻）
// 所有阈值集中于 config.ts，标注为工程初始参数、待历史回放校准。

import { TREND_WATCH } from './config';
import type { VolatilityFeatures } from './indicators';
import type { TrendCycleId, TrendEndReason, TrendDir, TrendPhaseV2 } from './signal';
import { mapUtePhase } from './signal';

/** 1m 主周期（本子系统固定；证据 bar 收盘时刻 = barTime + BAR_MS） */
const BAR_MS = 60_000;

/** 证据幂等键上限（保留最近 N 个 barTime；END_CONFIRM_BARS=3 + 富余） */
const EVIDENCE_KEYS_MAX = 6;

/** 生命周期内部状态（持久化到 TrendWatchSymbol.lifecycleStateJson，重启恢复） */
export interface LifecycleState {
  symbol: string;
  /** 当前展示相位（含 END_PENDING/DATA_UNAVAILABLE 等扩展相位） */
  phase: TrendPhaseV2;
  /** 当前趋势周期（confirmed 时生成；ENDED 后保留到新周期确认为止——周期匹配离场依赖它） */
  cycleId: TrendCycleId | null;
  cycleDir: TrendDir;
  cycleStartedAt: number | null;
  /** END_PENDING 起始时刻（最近一段连续证据的起点；条件恢复清零） */
  endPendingSince: number | null;
  /** 连续结束证据根数（仅统计不同的已收盘 K 线；中断即清零） */
  endEvidenceBars: number;
  /** 最近一次计入证据的已收盘 K 线开盘时间（同根去重，与 UTE lastObservationKey 同纪律） */
  endEvidenceBarTime: number | null;
  /** 证据幂等键（本周期内已计入证据的 barTime 列表；持久化——重启后不重复计数） */
  endEvidenceBarTimes: number[];
  endedAt: number | null;
  endReason: TrendEndReason | null;
}

export function createLifecycleState(symbol: string): LifecycleState {
  return {
    symbol,
    phase: 'OBSERVING',
    cycleId: null,
    cycleDir: 'flat',
    cycleStartedAt: null,
    endPendingSince: null,
    endEvidenceBars: 0,
    endEvidenceBarTime: null,
    endEvidenceBarTimes: [],
    endedAt: null,
    endReason: null,
  };
}

/** 旧版本状态 JSON 恢复兼容：补齐 endEvidenceBarTimes（缺失时从 endEvidenceBarTime 推导） */
export function normalizeLifecycleState(raw: Partial<LifecycleState> & { symbol: string }): LifecycleState {
  const base = createLifecycleState(raw.symbol);
  const times = Array.isArray(raw.endEvidenceBarTimes)
    ? raw.endEvidenceBarTimes.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
    : raw.endEvidenceBarTime != null
      ? [raw.endEvidenceBarTime]
      : [];
  return {
    ...base,
    ...raw,
    endEvidenceBarTimes: times.slice(-EVIDENCE_KEYS_MAX),
    endEvidenceBars: typeof raw.endEvidenceBars === 'number' ? raw.endEvidenceBars : times.length,
    endEvidenceBarTime: raw.endEvidenceBarTime ?? times[times.length - 1] ?? null,
  };
}

/** UTE 评估输入（本状态机不自己算方向，全部来自 UTE 结果） */
export interface LifecycleInput {
  /** UTE 相位（idle/candidate/confirmed） */
  utePhase: 'idle' | 'candidate' | 'confirmed';
  /** UTE 方向（仅 confirmed 相位有值；candidate 相位下 UTE direction=flat） */
  uteDirection: TrendDir;
  /** UTE 候选方向（candidate 相位的方向载体；可能与 confirmed 周期方向相反 = 反向证据） */
  uteCandidateDirection: TrendDir;
  /** UTE 方向一致性（features.directionalConsistency，证据 C 用） */
  directionalConsistency: number;
  /** UTE 窗口收益 %（features.returnPct；带方向语义：up 为正） */
  returnPct: number;
  /** 最近已收盘 K 线开盘时间（同根去重键；null = 数据异常不推进计数） */
  barTime: number | null;
  /** UTE 确认时刻（confirmed 相位 changedAt——生成 cycleId 用） */
  uteChangedAt: number | null;
  /** UTE 连续确认计数 */
  uteConfirmCount: number;
  /** UTE 评分 */
  uteScore: number;
  /** 方向强度（returnStrength 0-1） */
  strength: number;
  /** 波动率/结构特征（证据 C 用；null = 数据不足不推进结束判定） */
  features: VolatilityFeatures | null;
  /** 数据是否可用（false → DATA_UNAVAILABLE，冻结一切状态迁移） */
  dataOk: boolean;
  now: number;
}

export interface LifecycleResult {
  state: LifecycleState;
  phase: TrendPhaseV2;
  /** 相位是否发生变化（持久化触发条件之一） */
  changed: boolean;
  /** 展示理由 */
  reason: string;
  /** 本次证据评估被忽略的原因（同根去重/周期出生 bar/历史证据）——日志还原用，null=未涉及 */
  evidenceSkipped?: 'DUPLICATE_BAR' | 'BIRTH_BAR' | null;
  /** 本根 K 线是否新计入了结束证据 */
  evidenceCounted?: boolean;
}

function cycleIdOf(symbol: string, dir: 'up' | 'down', startedAt: number): TrendCycleId {
  return `${symbol}:${dir === 'up' ? 'L' : 'S'}:${startedAt}`;
}

/** 证据类型（内部；映射到 TrendEndReason 见 endReasonOf） */
type EvidenceKind = 'REVERSE_CANDIDATE' | 'DECAY' | 'STRUCTURE_ER' | 'STRUCTURE_CONSIST';

function endReasonOf(ev: EvidenceKind): TrendEndReason {
  switch (ev) {
    case 'REVERSE_CANDIDATE':
      return 'CONFIRMED_REVERSAL'; // 连续多根反向候选确认完毕——反向运动成立
    case 'STRUCTURE_ER':
    case 'STRUCTURE_CONSIST':
      return 'STRUCTURE_INVALIDATION';
    case 'DECAY':
      return 'DECAY';
  }
}

/**
 * 单步推进：输入必须已是「新的一根已收盘 K 线」的评估结果（同根重复输入由 barTime 去重）。
 * 数据不可用（dataOk=false / barTime=null / features=null）→ 冻结为 DATA_UNAVAILABLE，
 * 绝不推进结束计数、绝不产生结束原因（Task 56 §2.1/§3.2）。
 */
export function stepLifecycle(prev: LifecycleState, input: LifecycleInput): LifecycleResult {
  const next: LifecycleState = { ...prev, endEvidenceBarTimes: [...prev.endEvidenceBarTimes] };
  let changed = false;
  let reason = '';
  const result = (extra: Partial<LifecycleResult> = {}): LifecycleResult => ({
    state: next,
    phase: next.phase,
    changed,
    reason,
    ...extra,
  });

  // ---- 数据不可用：冻结判断（不伪装趋势结束；恢复后按正常规则继续） ----
  // Task 56：barTime=null（未收盘/时间戳无效）在此被拦截——绝不进入证据评估
  if (!input.dataOk || input.barTime == null || input.features == null) {
    if (next.phase !== 'DATA_UNAVAILABLE') {
      next.phase = 'DATA_UNAVAILABLE';
      changed = true;
      reason = '数据不可用（行情过期/K线不足/拉取失败），暂停趋势判断，恢复后继续';
    } else {
      reason = '数据不可用，趋势判断冻结';
    }
    return result();
  }

  const mapDir: TrendDir = input.utePhase === 'confirmed' ? input.uteDirection : input.uteCandidateDirection;
  const mapped = mapUtePhase(input.utePhase, mapDir);
  const cfg = TREND_WATCH;
  const features = input.features; // 非 null 已由上方 dataOk 守卫保证（闭包内窄化失效，显式捕获）

  // ---- 数据恢复归一：DATA_UNAVAILABLE → 回到最近有效语义（周期在 → CONFIRMED/END_PENDING）， ----
  // 使后续证据评估/结束判定不因数据断供而中断（证据计数保留；反向确认分支仍在前方覆盖）
  if (next.phase === 'DATA_UNAVAILABLE' && next.cycleDir !== 'flat' && next.cycleId) {
    next.phase =
      next.endEvidenceBars > 0
        ? 'END_PENDING'
        : next.cycleDir === 'up'
          ? 'CONFIRMED_UP'
          : 'CONFIRMED_DOWN';
  } else if (next.phase === 'DATA_UNAVAILABLE') {
    next.phase = 'OBSERVING'; // 无周期：跟随 UTE 重新评估
  }

  // ---- UTE 出现反向确认 → 当前周期立即结束（§3.2：独立确认的反向趋势可立即离场） ----
  // DATA_UNAVAILABLE 期间底层周期仍成立：断供后恢复若发现已反向确认，同样立即结束
  //（归一化后带周期的冻结态已回到 CONFIRMED_*/END_PENDING，此处无需再列 DATA_UNAVAILABLE）
  if (
    (next.phase === 'CONFIRMED_UP' ||
      next.phase === 'CONFIRMED_DOWN' ||
      next.phase === 'END_PENDING') &&
    input.utePhase === 'confirmed' &&
    next.cycleDir !== 'flat' &&
    mapDir !== 'flat' &&
    mapDir !== next.cycleDir
  ) {
    next.phase = 'ENDED';
    next.endedAt = input.now;
    next.endReason = 'CONFIRMED_REVERSAL';
    next.endPendingSince = null;
    next.endEvidenceBars = 0;
    next.endEvidenceBarTime = null;
    next.endEvidenceBarTimes = [];
    changed = true;
    reason = `反向趋势确认（${mapDir === 'up' ? '上涨' : '下跌'}），原${next.cycleDir === 'up' ? '上涨' : '下跌'}趋势结束`;
    return result();
  }

  // ---- ENDED 是终态：等 UTE 重新确认出新周期后才离开 ----
  if (next.phase === 'ENDED') {
    if (input.utePhase === 'confirmed' && mapDir !== 'flat') {
      next.phase = mapDir === 'up' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN';
      next.cycleId = cycleIdOf(next.symbol, mapDir, input.uteChangedAt ?? input.now);
      next.cycleDir = mapDir;
      next.cycleStartedAt = input.uteChangedAt ?? input.now;
      next.endPendingSince = null;
      next.endEvidenceBars = 0;
      next.endEvidenceBarTime = null;
      next.endEvidenceBarTimes = [];
      next.endedAt = null;
      next.endReason = null;
      changed = true;
      reason = `新趋势周期确认（${mapDir === 'up' ? '上涨' : '下跌'}）`;
    } else {
      reason = '趋势已结束，等待新趋势确认';
    }
    return result();
  }

  // ---- 结束证据评估（仅对已确认趋势有意义；candidate/observing 直接跟随 UTE 映射） ----
  // 证据 B 为方向感知动量衰减：up 周期看 returnPct < 阈值；down 周期看 returnPct > -阈值
  // （多空同口径、带方向语义；阈值 = minMovePct × END_MOMENTUM_RATIO < minMovePct，
  //  与入场确认线构成迟滞区间——刚确认的趋势不会立刻满足衰减条件）
  const evidenceOf = (): EvidenceKind | null => {
    if (next.cycleDir === 'flat') return null;
    // A：反向候选（UTE candidate 方向与当前周期相反）
    if (input.utePhase === 'candidate' && input.uteCandidateDirection !== 'flat' && input.uteCandidateDirection !== next.cycleDir) {
      return 'REVERSE_CANDIDATE';
    }
    // B：动量衰减（方向感知；多空口径对称）
    const decayLine = cfg.minMovePct * cfg.END_MOMENTUM_RATIO;
    if (next.cycleDir === 'up' ? input.returnPct < decayLine : input.returnPct > -decayLine) {
      return 'DECAY';
    }
    // C：结构失效（ER / 一致性）
    if (features.efficiencyRatio < cfg.END_ER_FLOOR) return 'STRUCTURE_ER';
    if (input.directionalConsistency < cfg.END_CONSISTENCY_FLOOR) return 'STRUCTURE_CONSIST';
    return null;
  };

  /** 证据是否允许计入本周期（幂等键 + 周期出生 bar 排除） */
  const acceptEvidence = (ev: EvidenceKind): { ok: boolean; skipped?: 'DUPLICATE_BAR' | 'BIRTH_BAR' } => {
    if (input.barTime == null) return { ok: false }; // 理论上不可达（顶层守卫），双保险
    if (next.endEvidenceBarTimes.includes(input.barTime)) return { ok: false, skipped: 'DUPLICATE_BAR' };
    // 周期出生所在 K 线不得作为该周期的结束证据（§2.3：只有周期创建后新收盘的 K 线才算）。
    // barTime 为已收盘 K 线开盘时间，收盘时刻 = barTime + BAR_MS；必须晚于周期创建时刻。
    if (next.cycleStartedAt != null && input.barTime + BAR_MS <= next.cycleStartedAt) {
      return { ok: false, skipped: 'BIRTH_BAR' };
    }
    return { ok: true };
  };

  const resetEvidence = (): void => {
    next.endPendingSince = null;
    next.endEvidenceBars = 0;
    next.endEvidenceBarTime = null;
    next.endEvidenceBarTimes = [];
  };

  const reachEnded = (ev: EvidenceKind): void => {
    next.phase = 'ENDED';
    next.endedAt = input.now;
    next.endReason = endReasonOf(ev);
    next.endPendingSince = null;
    next.endEvidenceBars = 0;
    next.endEvidenceBarTime = null;
    next.endEvidenceBarTimes = [];
  };

  if (next.phase === 'CONFIRMED_UP' || next.phase === 'CONFIRMED_DOWN') {
    const ev = evidenceOf();
    if (ev) {
      const acc = acceptEvidence(ev);
      if (!acc.ok) {
        // 同一根已收盘 K 线只计一次证据 / 周期出生 bar 不计——相位不变，仅刷新理由
        return result({ evidenceSkipped: acc.skipped ?? null, evidenceCounted: false });
      }
      next.endEvidenceBarTime = input.barTime!;
      next.endEvidenceBarTimes = [...next.endEvidenceBarTimes, input.barTime!].slice(-EVIDENCE_KEYS_MAX);
      next.endEvidenceBars += 1;
      if (next.endEvidenceBars === 1) next.endPendingSince = input.now;
      if (next.endEvidenceBars >= cfg.END_CONFIRM_BARS) {
        reachEnded(ev);
        reason = `趋势结束（连续 ${cfg.END_CONFIRM_BARS} 根结束证据：${ev}）`;
      } else {
        next.phase = 'END_PENDING';
        reason = `结束迹象（${ev}）${next.endEvidenceBars}/${cfg.END_CONFIRM_BARS}，等待确认`;
      }
      return result({ evidenceCounted: true, evidenceSkipped: null });
    }
    // 无证据：结束迹象消失（END_PENDING 恢复场景由下方兜底分支处理；
    // 此处 phase 必为 CONFIRMED_*，相位不变仅刷新理由）
    return result();
  }

  // ---- END_PENDING 兜底（恢复路径：重启恢复到 END_PENDING 后继续计数） ----
  if (next.phase === 'END_PENDING') {
    const ev = evidenceOf();
    if (ev) {
      const acc = acceptEvidence(ev);
      if (!acc.ok) {
        return result({ evidenceSkipped: acc.skipped ?? null, evidenceCounted: false });
      }
      next.endEvidenceBarTime = input.barTime!;
      next.endEvidenceBarTimes = [...next.endEvidenceBarTimes, input.barTime!].slice(-EVIDENCE_KEYS_MAX);
      next.endEvidenceBars += 1;
      if (next.endEvidenceBars >= cfg.END_CONFIRM_BARS) {
        reachEnded(ev);
        reason = `趋势结束（连续 ${cfg.END_CONFIRM_BARS} 根结束证据：${ev}）`;
      } else {
        reason = `结束迹象持续 ${next.endEvidenceBars}/${cfg.END_CONFIRM_BARS}`;
      }
      return result({ evidenceCounted: true, evidenceSkipped: null });
    }
    // 条件恢复：取消/重置对应的结束确认（§3.1.4——不继续累计已失效的证据）
    next.phase = next.cycleDir === 'up' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN';
    resetEvidence();
    changed = true;
    reason = '结束迹象消失，恢复已确认趋势';
    return result();
  }

  // ---- 未确认阶段（OBSERVING/CANDIDATE_*）：跟随 UTE 映射；candidate 方向变化即换向 ----
  if (mapped !== next.phase) {
    changed = true;
    if (input.utePhase === 'confirmed' && mapDir !== 'flat' && next.cycleId === null) {
      next.cycleId = cycleIdOf(next.symbol, mapDir, input.uteChangedAt ?? input.now);
      next.cycleDir = mapDir;
      next.cycleStartedAt = input.uteChangedAt ?? input.now;
      resetEvidence();
      reason = `趋势确认（${mapDir === 'up' ? '上涨' : '下跌'}，${input.uteConfirmCount} 根收盘 K 线）`;
    } else {
      reason = input.utePhase === 'candidate' && mapDir !== 'flat'
        ? `候选趋势（${mapDir === 'up' ? '上涨' : '下跌'}，${input.uteConfirmCount}/${cfg.confirmObservations}）`
        : '观察中';
    }
    next.phase = mapped;
    return result();
  }

  // 同相位：candidate 计数/评分变化也刷新理由（不标记 changed）
  reason =
    input.utePhase === 'candidate' && mapDir !== 'flat'
      ? `候选趋势（${mapDir === 'up' ? '上涨' : '下跌'}，${input.uteConfirmCount}/${cfg.confirmObservations}）`
      : '观察中';
  return result();
}

/** 数据恢复时清除 DATA_UNAVAILABLE 展示（真实相位由下一次有效评估决定；证据计数保留——
 * 数据断供不作为「打断连续确认」的手段，避免趋势借数据缺口逃避结束判定） */
export function unfreezeLifecycle(prev: LifecycleState): LifecycleState {
  if (prev.phase !== 'DATA_UNAVAILABLE') return prev;
  if (prev.cycleDir !== 'flat' && prev.cycleId) {
    return {
      ...prev,
      phase: prev.endEvidenceBars > 0 ? 'END_PENDING' : prev.cycleDir === 'up' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN',
    };
  }
  return { ...prev, phase: 'OBSERVING' };
}
