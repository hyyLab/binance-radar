// ---------- 升级版异动交易 · 全部可校准参数 ----------
// 规格书原则：所有阈值均为初始工程参数，需通过历史回放与模拟运行校准。
// 本文件是唯一调参入口；数值旁注释标明含义与校准建议。

import type { LiquidityTier } from './types';

// ===== SPIKE（§三）=====
export const SPIKE = {
  /** 检测节奏跟随引擎 2s tick */
  fixed: {
    m1Minor: 1.0, // 1m 窗口 MINOR 固定阈值 %
    m1Major: 2.0,
    m5Minor: 2.0, // 5m 窗口 MINOR 固定阈值 %
    m5Major: 3.5,
  },
  /** 自适应：实际阈值 = max(固定阈值, 近期正常波动基准 × 倍数)。
   *  倍数经历史回放确定后再调；初始取 MINOR×3 / MAJOR×6（中位数的 3/6 倍） */
  adaptiveMultMinor: 3,
  adaptiveMultMajor: 6,
  /** 波动基准统计窗口 */
  baselineHours1m: 6, // 1m 收益率参考过去 6h 完整 1m K 线
  baselineHours5m: 12, // 5m 对应 12h
  minSamples: 60, // 样本低于此数退回固定阈值
  /** 极端绝对幅度 → 立即复核通道（不必等相对波动条件） */
  extremeM1: 8.0, // %
  extremeM5: 12.0, // %
  /** 流动性门槛 */
  minQv24h: 1_000_000,
  minQv1m: 10_000,
} as const;

// ===== BREAKOUT（§四）=====
export const BREAKOUT = {
  minQv24h: 5_000_000,
  /** 最小突破缓冲 = max(tickSize × tickMult, price × pctBuffer) */
  tickMult: 2,
  pctBuffer: 0.0003, // 0.03%
  /** 确认 A：连续有效报价在边界外（2s tick 节奏，3 次 ≈ 6s，规格建议 4~6s） */
  confirmTicks: 3,
  /** 确认 B：1m 收盘价仍在边界外（轮换更新时检查最后一根已收盘 K 线） */
  confirmByClose: true,
  /** 假突破观察期：确认后价格回到区间内标记 FALSE；观察窗口内允许重新突破 */
  falseObservationMs: 90_000,
  /** 异常突破保护：瞬时偏离基准超过该幅度 → REVIEW（复核而非直接推送/丢弃） */
  anomalyPct: 25, // %
  /** 复核通过条件：连续 N 次 tick 价格仍在界外 + 1m 成交额 ≥ 复核成交额门槛 */
  reviewTicks: 5,
  reviewMinQv1m: 50_000,
} as const;

// ===== VOLUME_SURGE（§五）=====
export const VOLUME = {
  minQv24h: 5_000_000,
  minQv1m: 50_000,
  minorMult: 6,
  majorMult: 12,
  majorAbsQv1m: 2_000_000, // 绝对成交额 MAJOR 条件
  /** 历史基准：过去 20 根完整 1m K 线成交额中位数 */
  baselineCandles: 20,
  /** 基线中位数低于该值视为 BASELINE_INSUFFICIENT，不输出倍数 */
  minBaselineQv: 1_000,
  /** 价格方向判定：|5m 涨跌幅| ≥ 该值才算 UP/DOWN，否则 NEUTRAL */
  dirMinChg5m: 0.3, // %
} as const;

// ===== 流动性分层（§六）：边界不写死市场，仅初始工程值 =====
export const TIERS = {
  HIGH_QV: 20_000_000, // 高流动性：完整自适应阈值
  MID_QV: 5_000_000, // 中等：自适应 + 较严格成交额门槛
  LOW_QV: 1_000_000, // 低：提高确认要求；行情质量不足不给方向
} as const;

export function tierOf(qv24h: number): LiquidityTier {
  if (qv24h >= TIERS.HIGH_QV) return 'HIGH';
  if (qv24h >= TIERS.MID_QV) return 'MID';
  if (qv24h >= TIERS.LOW_QV) return 'LOW';
  return 'NONE';
}

// ===== 行情有效性（§2.2）=====
export const VALIDITY = {
  maxTickAgeMs: 10_000, // 行情时间戳超过该值视为延迟
  suspectChg1m: 50, // 1m 涨跌幅超过 ±50% 进入疑似异常复核 %
  suspectChg5m: 80,
  /** 复核：连续 N 次 tick 仍保持同量级价格 + 成交额支持 → 判为真实 */
  reviewTicks: 5,
  reviewMinQv1m: 20_000,
} as const;

// ===== 事件聚合（§七）=====
export const AGG = {
  mergeWindowMs: 60_000, // 同币种同方向 60s 内优先合并
  cooldownMs: 5 * 60_000, // 兜底冷却（保留原 5 分钟，但不机械执行）
  quietEndMs: 90_000, // 条件消失且价格稳定该时长后事件结束
  coolDownQuietMs: 45_000, // 曾达 P1 的事件静默该时长后先降出 P1 进冷却池（动量衰减；须 < quietEndMs）
  maxEventAgeMs: 30 * 60_000, // 事件最长存活
  maxEventsKept: 400, // 已结束事件保留条数（内存）
} as const;

// ===== K 线仓库与请求预算 =====
export const STORE = {
  keepHours: 26, // 保留 26h（>24h 基线 + 余量）
  maxTracked: 220, // K 线跟踪标的数上限（请求预算护栏）
  bootBackfillCap: 120, // 冷启动立即回填的标的数（按成交额降序）
  bootConcurrency: 2, // 冷启动回填并发（防突发）
  bootGapMs: 1500, // 回填批次间隔（Task 50：fapi 对本 IP 实测有比 2400 更严的隐性限制，1500ms 压峰值权重至 ~400/min）
  rotateMs: 5 * 60_000, // 单标的基线轮换周期
  rotatePerTick: 6, // 每个轮换 tick 处理的标的数（1 req/标的）
  rotationSlots: 25, // 轮换分片数（5min = 25×12s）
  expansionPerSec: 0.8, // 冷启动后补充回填速率（req/s）
  exchangeInfoRefreshMs: 60 * 60_000, // 交易对状态/精度每小时刷新
  collectReadyWaitMs: 15_000, // 启动后先等 collector 就绪再回填
} as const;

// ===== 方向判断（§八）=====
export const DIRECTION = {
  bull24h: 3.0, // 24h ≥ +3% 大背景偏强
  bear24h: -2.0, // 24h ≤ -2% 大背景偏弱
  /** 短线趋势阈值（15m/1h 收益率） */
  shortBull: 0.8, // 15m ≥ +0.8% 视为短线偏强
  shortBear: -0.8,
  /** 冲高/杀跌回落判定：回撤超过事件窗口振幅的该比例标记风险 */
  retraceRatio: 0.5,
} as const;

// ===== 通知（§十）=====
export const NOTIFY = {
  /** P3 仅记录的事件不作为"新提醒"高亮 */
  highlightMinPriority: 'P2' as const,
};
