// ---------- 趋势跟踪 · 全部可调参数 ----------
// 与 enhanced/config.ts 同一纪律：本文件是唯一调参入口，所有阈值为初始工程参数，
// 未经历史回放校准，不构成经回测验证的盈利规则。校准前不得将趋势确认视为买卖指令。

import type { TrendConfig } from 'universal-trend-engine';

// ===== 候选池容量与生命周期 =====
export const TREND_WATCH = {
  /** 候选池容量上限（= K 线刷新请求预算护栏：20 标的 × 1 req/60s ≈ 20 req/min） */
  MAX_TREND_SYMBOLS: 20,
  /** 候选过期：最后一次「活跃异动续期」后该时长内无新异动且 UTE 趋势 idle → 退池 */
  CANDIDATE_TTL_MS: 30 * 60_000,
  /** 已确认趋势（confirmed）不因事件结束退池；仅当趋势回落 idle 后，宽限该时长仍无异动续期 → 退池 */
  CONFIRMED_IDLE_EXIT_MS: 15 * 60_000,
  /** 数据断供退出：K 线持续该时长拉不到更新（任何相位，含 confirmed）→ 退池 */
  STALE_DATA_EXIT_MS: 15 * 60_000,
  /** 趋势回落 idle 后的宽限（从未确认过的普通候选；与 CANDIDATE_TTL_MS 共同决定退出） */
  IDLE_EXIT_MS: 15 * 60_000,

  // ===== 候选评分（入池选择分，非 UTE 趋势分；工程参数，未经回测校准） =====
  /** 入池最低分 */
  SCORE_MIN_ENTRY: 40,
  /** 迟滞：在池标的的保留下限 = SCORE_MIN_ENTRY - SCORE_HYSTERESIS（防排名抖动频繁进出） */
  SCORE_HYSTERESIS: 15,
  /** P1/P2/P3 优先级基础分 */
  wPriorityP1: 40,
  wPriorityP2: 25,
  wPriorityP3: 10,
  /** 事件等级分 */
  wMajor: 20,
  wMinor: 8,
  /** 每种独立证据类型加分（同类型不凑数，与聚合器口径一致） */
  wEvidenceEach: 8,
  /** 有效突破（CONFIRMED）加分 */
  wBreakoutConfirmed: 15,
  /** 放量倍数加分：min(wVolumeMultCap, volumeMultiple × wVolumeMultPer) */
  wVolumeMultPer: 4,
  wVolumeMultCap: 20,
  /** 事件仍 ACTIVE 的加分；ENDED 事件按 endedDecayMs 线性衰减到 0 */
  wActiveFresh: 10,
  endedDecayMs: 30 * 60_000,

  // ===== 流动性门槛（用户定版初始条件） =====
  /** 24h 成交额 ≥ 500 万 USDT：正常参与竞争 */
  QV_NORMAL: 5_000_000,
  /** 100 万 ~ 500 万：仅 MAJOR 级异动且（有效突破 或 ≥3 种独立证据）时作为例外候选 */
  QV_EXCEPTION: 1_000_000,
  /** 例外通道要求的独立证据种类数 */
  EXCEPTION_MIN_KINDS: 3,

  // ===== K 线刷新（1m 主周期） =====
  /** 每候选刷新间隔（约 60s；实际 ≤ 该值受并发与到期检查粒度影响） */
  KLINE_INTERVAL_MS: 60_000,
  /** 每次拉取的 1m 根数（保留最近 60 根；UTE 需 minBars=16 已收盘） */
  KLINE_BARS: 60,
  /** 初始并发上限（同一标的不并发重复请求由 inflight 去重保证） */
  KLINE_CONCURRENCY: 3,
  /** 最新收盘 bar 距今超过该值视为数据过期（3 根 1m 未更新） */
  KLINE_STALE_MS: 180_000,

  // ===== 扫描节奏 =====
  /** 主扫描 tick（到期检查粒度） */
  SCAN_MS: 5_000,
  /** 候选池重建周期（异动事件 → 候选评分） */
  REBUILD_MS: 30_000,

  // ===== 有效性门控 =====
  /** 行情时间戳年龄上限（对齐 enhanced VALIDITY.maxTickAgeMs） */
  MAX_TICK_AGE_MS: 10_000,
  /** 参与趋势判断的最少已收盘 K 线数（= UTE 默认 minBars） */
  MIN_CLOSED_BARS: 16,

  // ===== Universal Trend Engine 参数（集中于此，待回放校准） =====
  /** 趋势回看窗口（根） */
  lookbackBars: 12,
  /** 方向判定的最小窗口收益 % */
  minMovePct: 0.35,
  /** 确认所需的不同已收盘 bar 观察次数 */
  confirmObservations: 3,
  /** 最新 bar 最大年龄（UTE 内置过期判定） */
  maxBarAgeMs: 5 * 60_000,
} as const;

/** 传给 UTE 的 TrendConfig 覆盖（其余项沿用 UTE 默认：minBars 16 / recentVolumeBars 3 /
 *  baselineVolumeBars 10 / strongVolumeRatio 2） */
export function trendEngineConfig(): Partial<TrendConfig> {
  return {
    lookbackBars: TREND_WATCH.lookbackBars,
    minMovePct: TREND_WATCH.minMovePct,
    confirmObservations: TREND_WATCH.confirmObservations,
    maxBarAgeMs: TREND_WATCH.maxBarAgeMs,
  };
}
