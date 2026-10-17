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

  // ===== Task 54：1m 主拉取长度（聚合 5m/15m 用） =====
  // 480 根 = 8h：15m 聚合得 32 根 ≥ UTE minBars 16（数据量充足，不伪造高周期确认）；
  // 币安权重 <500 根仍为 2/req，池内请求预算不变（≤20 req/min）
  KLINE_BARS_V2: 480,

  // ===== Task 54：趋势结束判定（END_PENDING → ENDED，全部待回放校准） =====
  /** 结束确认根数：连续 N 根「不同已收盘 K 线」都有结束证据才判 ENDED（防插针/短暂回撤） */
  END_CONFIRM_BARS: 3,
  /** 深回撤证据阈值：|窗口收益| 低于 minMovePct × 该倍数才算「方向衰减」证据（浅回撤容忍带） */
  END_IDLE_TOL_MUL: 2.5,
  /** 结构失效：ER 低于该值视为震荡（indicators.erFloor 同源） */
  END_ER_FLOOR: 0.25,
  /** 结构失效：方向一致性低于该值视为失稳 */
  END_CONSISTENCY_FLOOR: 0.35,

  // ===== Task 54：主动探针通道（不依赖异动事件的候选发现，预算可配） =====
  /** 每轮池重建最多探测多少个「未在池」标的（每 30s 一轮 → 默认 8 req/min 额外预算） */
  PROBE_PER_REBUILD: 4,
  /** 探针标的流动性下限（24h 成交额，USDT） */
  PROBE_QV_MIN: 5_000_000,
  /** 探针「形成中趋势」入池特征门槛：ER 下限 */
  PROBE_ER_MIN: 0.35,
  /** 探针：方向一致性下限 */
  PROBE_CONSISTENCY_MIN: 0.6,
  /** 探针：量比下限（近 3 根均量 / 前 10 根基线均量） */
  PROBE_VOLUME_RATIO_MIN: 1.3,
  /** 探针：区间扩张下限 */
  PROBE_RANGE_EXPANSION_MIN: 1.2,
  /** 探针：窗口收益上限 %——|收益| 超过该值视为「已走完」的大行情，不再作为「形成中」候选 */
  PROBE_RETURN_MAX_PCT: 4,
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
