// ---------- PA 整合（pa-action-v1）· 类型定义 ----------
// 全部跨模块共享类型集中于此。纪律：
// - PA 永远只是「趋势内的择时器」：UTE 给方向，PA 给入场/止损/止盈与价格行为否决权。
// - 协同判断不改写任何一方的原始结果（UTE 原始信号与 PA 原始诊断全量留档）。
// - AI 失败 / 数据不完整 / 校验不通过 → 一律 WAIT 或 REJECT，绝不降级为 UTE-only 开仓。

import type { UnifiedTrendSignal } from '../market/trend-watch/signal';

// ============ 池宇宙（pool-universe） ============

/** 统一池读取接口的条目（各业务池适配为同一形状） */
export interface RadarPoolSymbol {
  symbol: string;
  poolId: string;
  poolName: string;
  /** 池内状态原文（如 ACTIVE / CONFIRMED_UP / WATCHING；展示用） */
  status: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
  rank?: number;
  reason?: string;
  /** 池内方向（有则带出：异动 UP/DOWN、UTE up/down） */
  dir?: 'UP' | 'DOWN' | 'up' | 'down' | null;
  /** 额外权重信息（如 UTE score） */
  score?: number;
}

/** 单个业务池数据源（新增池 = 实现本接口 + 注册进 POOL_SOURCES） */
export interface RadarPoolSource {
  poolId: string;
  poolName: string;
  /** 一句话说明数据形态（页面「扫描范围」展示） */
  describe: string;
  /** 拉取池内全部当前活跃 symbol（实现必须只读、不得抛错——内部自捕获） */
  getSymbols(): Promise<RadarPoolSymbol[]>;
}

/** 去重合并后的扫描对象 */
export interface PoolUniverseEntry {
  symbol: string;
  sourcePools: RadarPoolSymbol[];
  poolFirstSeenAt: number | null;
  poolLastSeenAt: number | null;
}

export interface PoolUniverseResult {
  ts: number;
  pools: { poolId: string; poolName: string; count: number; describe: string; error: string | null }[];
  entries: PoolUniverseEntry[];
  totalRaw: number;
}

// ============ 候选状态机（candidate-scanner） ============

export type PACandidateStatus =
  | 'DISCOVERED' // 全池发现，尚未通过快速筛选
  | 'ELIGIBLE' // 通过快速筛选（UTE 方向有效 + 数据可用），待 PA 分析
  | 'PA_ANALYZING' // AI 分析中（队列内）
  | 'WAITING_CONFIRMATION' // 协同 = WAIT（回调分歧/信息不足），跟踪后续 5m 收盘
  | 'PLAN_READY' // 协同 ALLOW + Stage2 计划 + Validator 全过，待入场单已建/待触发
  | 'REJECTED' // 协同 REJECT（结构性冲突）或 Validator 拒绝
  | 'EXPIRED'; // 冷却/退池/长期未确认，退出扫描视野

export type CoordinationState =
  | 'ALIGNED'
  | 'PULLBACK_DIVERGENCE'
  | 'STRUCTURAL_CONFLICT'
  | 'UNCERTAIN';

export type CoordinationDecision = 'ALLOW' | 'WAIT' | 'REJECT';

// ============ PA 诊断（Stage1 / 15m 背景） ============

/** 逐K角色（Stage1 bar_by_bar_summary 条目） */
export interface PaBarRole {
  bar: string;
  role: string;
  reason: string;
}

/** Stage1 市场诊断（5m 主分析）——保留全量字段，不只提方向 */
export interface PaDiagnosis {
  cycle_position: string;
  alternative_cycle_position: string | null;
  direction: 'bullish' | 'bearish' | 'neutral';
  diagnosis_confidence: number;
  market_phase: 'stable' | 'transitioning';
  support_levels: string[];
  resistance_levels: string[];
  detected_patterns: string[];
  key_signals: string[];
  htf_context: string;
  entry_setup: string;
  bar_by_bar_summary: PaBarRole[];
  gate_result: { pass: boolean; reason: string };
}

/** 15m 高周期背景（同 Stage1 提示词跑 15m 数据，消费其方向/阶段/结构字段） */
export interface PaHtfBackground {
  cycle_position: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  diagnosis_confidence: number;
  market_phase: 'stable' | 'transitioning';
  htf_context: string;
  gate_result: { pass: boolean; reason: string };
}

// ============ PA 交易计划（Stage2 + Validator） ============

export type PaOrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET';

/** Stage2 产出的原始交易计划（AI 输出归一化后；validator 通过才算 PaTradePlan） */
export interface PaRawPlan {
  symbol: string;
  orderType: PaOrderType;
  direction: 'LONG' | 'SHORT';
  entryPrice: number | null;
  entryBasisBar: string | null;
  entryBasisExtreme: 'high' | 'low' | null;
  entryRule: string | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  estimatedWinRate: number | null;
  reasoning: string;
  tradeConfidence: number;
  invalidationCondition: string | null;
}

/** 校验通过并落库的交易计划（附程序校验产物） */
export interface PaTradePlan extends PaRawPlan {
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  estimatedWinRate: number;
  /** 真实风险收益比（程序计算，非模型口径） */
  rewardRisk: number;
  riskPerUnit: number;
  /** validator 检查清单（id + 通过/拒绝 + 说明） */
  checks: PaValidationCheck[];
  /** 生成该计划依据的 5m 收盘 bar（幂等键组成） */
  barTime5m: number;
  promptVersion: string;
  analysisId: string;
}

export interface PaValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

// ============ 协同判断（coordination-engine） ============

export interface CoordinationInput {
  ute: {
    direction: 'up' | 'down' | 'flat';
    phase: string;
    trendCycleId: string | null;
    score: number;
    signalTime: number | null;
    sourceSignal: UnifiedTrendSignal;
  };
  pa: {
    diagnosis: PaDiagnosis | null;
    htf: PaHtfBackground | null;
    analysisTime: number;
    barTime5m: number;
  };
  mark: number;
}

export interface CoordinationResult {
  state: CoordinationState;
  decision: CoordinationDecision;
  /** 可追溯的具体证据（结构化；页面/审计直接展示） */
  evidences: string[];
  /** 一句话中文理由 */
  reason: string;
}

// ============ 待入场单 / 持仓（pa-trader） ============

export type PaPendingStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED';
export type PaPendingKind = 'MARKET' | 'LIMIT' | 'STOP_MARKET';

export interface PaPendingOrderRow {
  id: string; // `{symbol}:{direction}:{barTime5m}` 决策幂等键
  symbol: string;
  direction: 'LONG' | 'SHORT';
  kind: PaPendingKind;
  triggerPrice: number; // LIMIT=限价 / STOP_MARKET=触发价 / MARKET=创建时标记价
  maxDeviationPct: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  qty: number;
  leverage: number;
  margin: number;
  status: PaPendingStatus;
  cancelReason: string | null;
  positionId: string | null;
  planId: string;
  analysisId: string;
  barTime5m: number;
  createdAt: number;
  triggeredAt: number | null;
  updatedAt: number;
}

export type PaPositionStatus = 'PENDING_ENTRY' | 'OPEN' | 'TP1_PARTIAL' | 'CLOSED' | 'CANCELLED';

export type PaExitReason =
  | 'STOP_LOSS'
  | 'TP2_FINAL'
  | 'TREND_ENDED'
  | 'PA_STRUCTURE_INVALID'
  | 'REVERSE_CONFIRMED'
  | 'LIQUIDATED'
  | 'MANUAL';

/** PA 持仓元数据（positionId = PaperPosition.id 一一对应；仓位本体在 PaperPosition） */
export interface PaPositionMetaRow {
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: PaPositionStatus;
  planId: string;
  analysisId: string;
  trendCycleId: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  initialQty: number;
  remainingQty: number;
  tp1Done: number; // 0/1
  tp2Done: number; // 0/1
  breakevenMoved: number; // 0/1
  realizedPnl: number; // 已落袋净盈亏（含费用，含滑点口径另计）
  exitReason: PaExitReason | null;
  openedAt: number;
  closedAt: number | null;
  updatedAt: number;
}

// ============ 配置（config） ============

export interface PaActionConfig {
  enabled: number; // 策略总开关 0/1（暂停=0 但持仓继续管理）
  aiEnabled: number; // AI 分析开关（关闭只停新分析，不停退出管理）
  mainTimeframe: string; // 固定 '5m'（任务书 §四）
  htfTimeframe: string; // 固定 '15m'
  riskPerTradePct: number; // 每笔风险占权益 %
  maxPositions: number;
  maxTotalRiskPct: number; // 策略总风险敞口上限（%权益）
  leverage: number;
  leverageCap: number;
  tp1CloseRatio: number; // TP1 平仓比例（0-1]
  breakevenAfterTp1: number; // 0/1
  orderExpiryMs: number;
  entryMaxDeviationPct: number;
  stopCooldownMs: number;
  analysisCooldownMs: number;
  aiConcurrency: number;
  minRiskReward: number;
  feeRate: number;
  slippageBps: number;
  updatedAt: number;
}

// ============ 分析记录（repository 持久化形状） ============

export interface PaAnalysisRecord {
  id: string; // `{symbol}:{barTime5m}:{promptVersion}`
  symbol: string;
  direction: 'LONG' | 'SHORT'; // UTE 方向（分析时快照）
  barTime5m: number;
  barTime15m: number;
  promptVersion: string;
  uteSnapshotJson: string;
  diagnosisJson: string;
  htfJson: string;
  coordinationState: CoordinationState;
  coordinationDecision: CoordinationDecision;
  coordinationJson: string;
  rawPlanJson: string | null;
  planJson: string | null;
  validatorJson: string | null;
  status: string; // OK | AI_FAILED | STALE | INVALID_PLAN
  error: string | null;
  aiLatencyMs: number;
  createdAt: number;
}
