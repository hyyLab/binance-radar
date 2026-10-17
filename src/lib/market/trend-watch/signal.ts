// ---------- 统一趋势信号 v2（Task 54：面板 / 自动交易 / 回放三方共同消费） ----------
// 纪律：方向与评分来自 UTE（单一趋势算法来源）；本文件定义的只是「标准化信封」，
// 把 UTE 评估 + 波动率特征 + 高周期过滤 + 生命周期（结束判定）封装成一份结构，
// 趋势面板、AutoPaperTrader、历史回放全部读取同一份，绝不出现第二套方向算法。
//
// ⚠️ score 为启发式证据分（UTE），未经校准不得称胜率/概率；趋势确认 ≠ 买卖指令
//    （是否交易由 AutoPaperTrader 的规则层决定，且纯模拟）。

import type { VolatilityFeatures, HtfAssessment } from './indicators';

/** 趋势生命周期阶段（任务 §2.3 语义，名称可对齐类型体系） */
export type TrendPhaseV2 =
  | 'OBSERVING' // 观察中（UTE idle / 未确认）
  | 'CANDIDATE_UP' // 候选上涨趋势（确认计数积累中）
  | 'CANDIDATE_DOWN' // 候选下跌趋势
  | 'CONFIRMED_UP' // 已确认上涨趋势
  | 'CONFIRMED_DOWN' // 已确认下跌趋势
  | 'END_PENDING' // 出现结束迹象，等待连续收盘 K 线确认（底层方向仍成立）
  | 'ENDED' // 趋势结束（终态，记录原因与时间）
  | 'DATA_UNAVAILABLE'; // 数据不足/行情过期：暂停判断，不伪装趋势结束

export type TrendDir = 'up' | 'down' | 'flat';

/** 趋势周期标识：{symbol}:{L|S}:{确认时刻ms}；持仓关联与交易幂等键的组成部分 */
export type TrendCycleId = string;

/** 结束原因（ENDED.endReason）——Task 56 细分（用户定版 §3.2）：
 *  DECAY / STRUCTURE_INVALIDATION 为「三根独立收盘 K 线持续证据」确认的结束；
 *  CONFIRMED_REVERSAL 为反向趋势独立确认后的立即结束；DATA_EXIT 为数据断供退池的
 *  治理性结束。数据缺失（DATA_UNAVAILABLE）绝不映射为任何结束原因。 */
export type TrendEndReason =
  | 'CONFIRMED_REVERSAL' // 相反方向趋势独立达到确认条件（可立即结束）
  | 'DECAY' // 趋势方向动量持续衰减（方向感知阈值，连续 N 根确认）
  | 'STRUCTURE_INVALIDATION' // 价格结构失效（ER / 方向一致性，连续 N 根确认）
  | 'DATA_EXIT'; // 数据断供退出池（治理性结束，非价格语义）

/** 异动上下文（入池依据的留痕，不参与方向判定） */
export interface AnomalyContextDTO {
  dir: 'UP' | 'DOWN' | null;
  level: 'MINOR' | 'MAJOR' | null;
  priority: 'P1' | 'P2' | 'P3' | null;
  active: boolean;
  lastAt: number | null;
}

export interface UnifiedTrendSignal {
  symbol: string;
  market: 'futures';
  interval: '1m';
  phase: TrendPhaseV2;
  /** 确认趋势的方向（CONFIRMED 系与 END_PENDING 相位下有意义；其他相位 flat） */
  direction: TrendDir;
  /** 趋势周期标识：同 symbol 同方向的「一次趋势episode」唯一（持仓关联 + 交易幂等键） */
  trendCycleId: string | null;
  /** 当前周期确认时刻（CONFIRMED 时生成） */
  trendStartedAt: number | null;
  /** END_PENDING 起始时刻 */
  endPendingSince: number | null;
  /** 已累计的结束证据根数（不同已收盘 K 线） */
  endEvidenceBars: number;
  endedAt: number | null;
  endReason: TrendEndReason | null;

  /** UTE 趋势评分（启发式证据分 0-100） */
  score: number;
  /** 方向强度 0-1（UTE returnStrength 口径：|returnPct| / (3×minMovePct) 饱和） */
  strength: number;
  /** UTE 连续确认计数（不同已收盘 K 线） */
  confirmCount: number;

  /** 波动率与结构特征（本模块计算） */
  features: VolatilityFeatures;
  /** 高周期过滤（5m/15m；valid=false 表示数据量不足，不得冒充有效确认） */
  htf5m: HtfAssessment;
  htf15m: HtfAssessment;
  /** 高周期方向与 1m 确认方向是否一致（仅 valid 时有意义） */
  htfAgree: boolean | null;

  // —— 数据新鲜度 ——
  /** 最近已参与评估的已收盘 1m K 线开盘时间 */
  lastBarTime: number | null;
  /** 最近 K 线拉取时间 */
  lastKlineAt: number;
  /** 数据是否足以支持交易（行情有效 + K 线数足够 + 未过期） */
  dataFresh: boolean;
  /** dataFresh=false 时的原因（展示用） */
  dataUnavailableReason: string | null;

  // —— 异动上下文与冲突 ——
  anomaly: AnomalyContextDTO;
  /** 异动方向与趋势方向冲突（明确展示，不静默覆盖） */
  conflict: boolean;

  /** 展示用判断理由（一句话） */
  reason: string;
  /** 本信号生成时间 */
  changedAt: number;
}

/** 由 UTE phase + direction 映射到 v2 相位（lifecycle 之外的纯映射） */
export function mapUtePhase(phase: 'idle' | 'candidate' | 'confirmed', dir: TrendDir): TrendPhaseV2 {
  if (phase === 'confirmed') return dir === 'up' ? 'CONFIRMED_UP' : dir === 'down' ? 'CONFIRMED_DOWN' : 'OBSERVING';
  if (phase === 'candidate') return dir === 'flat' ? 'OBSERVING' : dir === 'up' ? 'CANDIDATE_UP' : 'CANDIDATE_DOWN';
  return 'OBSERVING';
}

export function phaseLabel(p: TrendPhaseV2): string {
  switch (p) {
    case 'OBSERVING': return '观察中';
    case 'CANDIDATE_UP': return '候选上涨';
    case 'CANDIDATE_DOWN': return '候选下跌';
    case 'CONFIRMED_UP': return '确认上涨';
    case 'CONFIRMED_DOWN': return '确认下跌';
    case 'END_PENDING': return '结束待确认';
    case 'ENDED': return '已结束';
    case 'DATA_UNAVAILABLE': return '数据不可用';
  }
}
