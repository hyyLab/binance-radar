// ---------- 趋势生命周期状态机 v2（Task 54 §2.3） ----------
// 在 UTE（idle/candidate/confirmed + 同根 K 线去重）之上扩展趋势结束判定：
//   END_PENDING：出现结束迹象，但需连续 END_CONFIRM_BARS 根「不同已收盘 K 线」
//               都有证据才判 ENDED（防单根长影线/插针/短暂回撤直接触发离场）；
//   ENDED：终态（记录原因/时间）；DATA_UNAVAILABLE：数据不可用时冻结判断。
//
// 方向结论仍唯一来自 UTE assessment——本状态机只管理「生命周期语义」：
//   结束证据 A：UTE 出现反向 candidate/confirmed（candidateDirection 反向）
//   结束证据 B：深回撤——|窗口收益| < minMovePct × END_IDLE_TOL_MUL（浅回撤容忍带内不算）
//   结束证据 C：结构失效——ER < END_ER_FLOOR 或方向一致性 < END_CONSISTENCY_FLOOR
//   反向趋势达到 CONFIRMED → 立即 ENDED(REVERSE_CONFIRMED)，不等确认根数
// 所有阈值集中于 config.ts，标注为工程初始参数、待历史回放校准。

import { TREND_WATCH } from './config';
import type { VolatilityFeatures } from './indicators';
import type { TrendCycleId, TrendEndReason, TrendDir, TrendPhaseV2 } from './signal';
import { mapUtePhase } from './signal';

/** 生命周期内部状态（持久化到 TrendWatchSymbol.lifecycleStateJson，重启恢复） */
export interface LifecycleState {
  symbol: string;
  /** 当前展示相位（含 END_PENDING/DATA_UNAVAILABLE 等扩展相位） */
  phase: TrendPhaseV2;
  /** 当前趋势周期（confirmed 时生成；ENDED 后清空） */
  cycleId: TrendCycleId | null;
  cycleDir: TrendDir;
  cycleStartedAt: number | null;
  /** END_PENDING 起始时刻 */
  endPendingSince: number | null;
  /** 连续结束证据根数（仅统计不同的已收盘 K 线；中断即清零） */
  endEvidenceBars: number;
  /** 最近一次计入证据的已收盘 K 线开盘时间（同根去重，与 UTE lastObservationKey 同纪律） */
  endEvidenceBarTime: number | null;
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
    endedAt: null,
    endReason: null,
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
  /** UTE 窗口收益 %（features.returnPct） */
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
}

function cycleIdOf(symbol: string, dir: 'up' | 'down', startedAt: number): TrendCycleId {
  return `${symbol}:${dir === 'up' ? 'L' : 'S'}:${startedAt}`;
}

/** 单步推进：输入必须已是「新的一根已收盘 K 线」的评估结果（同根重复输入由 barTime 去重） */
export function stepLifecycle(prev: LifecycleState, input: LifecycleInput): LifecycleResult {
  const next: LifecycleState = { ...prev };
  let changed = false;
  let reason = '';

  // ---- 数据不可用：冻结判断（不伪装趋势结束；恢复后按正常规则继续） ----
  if (!input.dataOk || input.barTime == null || input.features == null) {
    if (next.phase !== 'DATA_UNAVAILABLE') {
      next.phase = 'DATA_UNAVAILABLE';
      changed = true;
      reason = '数据不可用（行情过期/K线不足/拉取失败），暂停趋势判断，恢复后继续';
    } else {
      reason = '数据不可用，趋势判断冻结';
    }
    return { state: next, phase: next.phase, changed, reason };
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

  // ---- UTE 出现反向确认 → 当前周期立即结束（任务 §2.3 条件 1） ----
  // DATA_UNAVAILABLE 期间底层周期仍成立：断供后恢复若发现已反向确认，同样立即结束
  if (
    (next.phase === 'CONFIRMED_UP' ||
      next.phase === 'CONFIRMED_DOWN' ||
      next.phase === 'END_PENDING' ||
      next.phase === 'DATA_UNAVAILABLE') &&
    input.utePhase === 'confirmed' &&
    next.cycleDir !== 'flat' &&
    mapDir !== 'flat' &&
    mapDir !== next.cycleDir
  ) {
    next.phase = 'ENDED';
    next.endedAt = input.now;
    next.endReason = 'REVERSE_CONFIRMED';
    next.endPendingSince = null;
    next.endEvidenceBars = 0;
    next.endEvidenceBarTime = null;
    changed = true;
    reason = `反向趋势确认（${mapDir === 'up' ? '上涨' : '下跌'}），原${next.cycleDir === 'up' ? '上涨' : '下跌'}趋势结束`;
    return { state: next, phase: next.phase, changed, reason };
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
      next.endedAt = null;
      next.endReason = null;
      changed = true;
      reason = `新趋势周期确认（${mapDir === 'up' ? '上涨' : '下跌'}）`;
    } else {
      reason = '趋势已结束，等待新趋势确认';
    }
    return { state: next, phase: next.phase, changed, reason };
  }

  // ---- 结束证据评估（仅对已确认趋势有意义；candidate/observing 直接跟随 UTE 映射） ----
  const evidenceOf = (): string | null => {
    if (next.cycleDir === 'flat') return null;
    // A：反向候选（UTE candidate 方向与当前周期相反）
    if (input.utePhase === 'candidate' && input.uteCandidateDirection !== 'flat' && input.uteCandidateDirection !== next.cycleDir) {
      return 'REVERSE_CANDIDATE';
    }
    // B：深回撤（浅回撤容忍带：|returnPct| 仍 ≥ minMovePct × 容忍倍数 → 不算证据）
    if (Math.abs(input.returnPct) < cfg.minMovePct * cfg.END_IDLE_TOL_MUL) return 'DECAY';
    // C：结构失效（ER / 一致性）
    if (features.efficiencyRatio < cfg.END_ER_FLOOR) return 'STRUCTURE_ER';
    if (input.directionalConsistency < cfg.END_CONSISTENCY_FLOOR) return 'STRUCTURE_CONSIST';
    return null;
  };

  if (next.phase === 'CONFIRMED_UP' || next.phase === 'CONFIRMED_DOWN') {
    const ev = evidenceOf();
    if (ev) {
      // 同一根已收盘 K 线只计一次证据（重复扫描/轮询不推进计数）
      if (next.endEvidenceBarTime !== input.barTime) {
        next.endEvidenceBarTime = input.barTime;
        next.endEvidenceBars += 1;
        if (next.endEvidenceBars === 1) next.endPendingSince = input.now;
      }
      if (next.endEvidenceBars >= cfg.END_CONFIRM_BARS) {
        next.phase = 'ENDED';
        next.endedAt = input.now;
        next.endReason = ev === 'REVERSE_CANDIDATE' ? 'REVERSE_CONFIRMED' : 'DECAY_CONFIRMED';
        next.endPendingSince = null;
        next.endEvidenceBars = 0;
        next.endEvidenceBarTime = null;
        changed = true;
        reason = `趋势结束（连续 ${cfg.END_CONFIRM_BARS} 根结束证据：${ev}）`;
      } else {
        next.phase = 'END_PENDING';
        changed = true;
        reason = `结束迹象（${ev}）${next.endEvidenceBars}/${cfg.END_CONFIRM_BARS}，等待确认`;
      }
      return { state: next, phase: next.phase, changed, reason };
    }
    // 无证据：结束迹象消失（END_PENDING 恢复场景由下方兜底分支处理；
    // 此处 phase 必为 CONFIRMED_*，相位不变仅刷新理由）
    return { state: next, phase: next.phase, changed, reason: '趋势持续' };
  }

  // ---- END_PENDING 兜底（恢复路径：重启恢复到 END_PENDING 后继续计数） ----
  if (next.phase === 'END_PENDING') {
    const ev = evidenceOf();
    if (ev) {
      if (next.endEvidenceBarTime !== input.barTime) {
        next.endEvidenceBarTime = input.barTime;
        next.endEvidenceBars += 1;
      }
      if (next.endEvidenceBars >= cfg.END_CONFIRM_BARS) {
        next.phase = 'ENDED';
        next.endedAt = input.now;
        next.endReason = ev === 'REVERSE_CANDIDATE' ? 'REVERSE_CONFIRMED' : 'DECAY_CONFIRMED';
        next.endPendingSince = null;
        next.endEvidenceBars = 0;
        next.endEvidenceBarTime = null;
        changed = true;
        reason = `趋势结束（连续 ${cfg.END_CONFIRM_BARS} 根结束证据：${ev}）`;
      } else {
        reason = `结束迹象持续 ${next.endEvidenceBars}/${cfg.END_CONFIRM_BARS}`;
      }
      return { state: next, phase: next.phase, changed, reason };
    }
    next.phase = next.cycleDir === 'up' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN';
    next.endPendingSince = null;
    next.endEvidenceBars = 0;
    next.endEvidenceBarTime = null;
    changed = true;
    reason = '结束迹象消失，恢复已确认趋势';
    return { state: next, phase: next.phase, changed, reason };
  }

  // ---- 未确认阶段（OBSERVING/CANDIDATE_*）：跟随 UTE 映射；candidate 方向变化即换向 ----
  if (mapped !== next.phase) {
    changed = true;
    if (input.utePhase === 'confirmed' && mapDir !== 'flat' && next.cycleId === null) {
      next.cycleId = cycleIdOf(next.symbol, mapDir, input.uteChangedAt ?? input.now);
      next.cycleDir = mapDir;
      next.cycleStartedAt = input.uteChangedAt ?? input.now;
      next.endPendingSince = null;
      next.endEvidenceBars = 0;
      next.endEvidenceBarTime = null;
      reason = `趋势确认（${mapDir === 'up' ? '上涨' : '下跌'}，${input.uteConfirmCount} 根收盘 K 线）`;
    } else {
      reason = input.utePhase === 'candidate' && mapDir !== 'flat'
        ? `候选趋势（${mapDir === 'up' ? '上涨' : '下跌'}，${input.uteConfirmCount}/${cfg.confirmObservations}）`
        : '观察中';
    }
    next.phase = mapped;
    return { state: next, phase: next.phase, changed, reason };
  }

  // 同相位：candidate 计数/评分变化也刷新理由（不标记 changed）
  reason =
    input.utePhase === 'candidate' && mapDir !== 'flat'
      ? `候选趋势（${mapDir === 'up' ? '上涨' : '下跌'}，${input.uteConfirmCount}/${cfg.confirmObservations}）`
      : '观察中';
  return { state: next, phase: next.phase, changed, reason };
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
