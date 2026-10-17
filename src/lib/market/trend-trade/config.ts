// ---------- 趋势自动模拟交易 · 全部可调参数（Task 54 §3 / Task 56 用户定版） ----------
// 与 enhanced/config.ts、trend-watch/config.ts 同一纪律：本文件是唯一调参入口，
// 所有阈值为初始工程参数，未经历史回放校准，不构成经回测验证的盈利规则。
//
// ⚠️ 红线：纯模拟交易（不接入真实下单）；趋势确认 ≠ 盈利保证；强平是杠杆模拟的
//    执行结果而非模型止损，不得从统计中省略。

export const TREND_TRADE = {
  /** 独立账户名（PaperAccount.name；与手动盘 default 完全隔离） */
  ACCOUNT_NAME: 'trend-auto-v1',

  // ===== 运行参数（DB TrendAutoConfig 行为运行时真值；此处为首次播种/重置的默认值） =====
  /** 初始资金（USDT）——可配置（DB initialCapital），界面明确展示 */
  INITIAL_CAPITAL: 100,
  /** 每仓保证金占比上限（Task 65 用户定版语义修订）：实际生效比例 =
   *  min(本上限, 95% ÷ (当前持仓数+1))——单一持仓时自动用满 95% 配额（开最大仓位），
   *  并发持仓越多单仓自动越小（第 2 仓 47.5%、第 3 仓 31.7%…，动态槽位均分）。
   *  要同时开满 N 仓，把本上限调到 ≤ 95%/N（如 8 仓 ≈ 0.12）。
   *  95% 头寸 = 预留 ~5% 给手续费与浮动亏损缓冲。保证金 + 开仓手续费超出可用余额时
   *  直接跳过该笔并记录原因，不得变相提高杠杆/比例。 */
  MARGIN_RATIO: 0.95,
  /** 满仓头寸预算（Task 58 建；Task 65 语义修订）：当前持仓槽位（已持仓数+1）的保证金
   *  合计 ≈ 权益 × 本值，剩余 ~5% 覆盖开仓手续费（20x 杠杆、费率 0.02% 下开仓手续费
   *  ≈ 权益 × 0.38%）与浮动亏损。 */
  MARGIN_SLOT_HEADROOM: 0.95,
  /** 持仓数量（最大同时持仓数）可选项（界面下拉） */
  MAX_POSITIONS_OPTIONS: [1, 2, 3, 4, 5, 6, 8] as const,
  /** 固定杠杆（用户定版 20 倍） */
  LEVERAGE: 20,
  /** 最大同时持仓数默认值（用户定版 §一.7：默认 3 笔；DB 运行时值可经界面调整） */
  MAX_POSITIONS: 3,
  /** 滑点估算（基点，单边）：开/平仓各计一次，成交记录展示并计入保守净盈亏 */
  SLIPPAGE_BPS: 2,
  /** 手续费率（单边，占名义价值；用户定版 Task 59）：买入/卖出（开仓/平仓）都按 0.02% 收，
   *  双边合计 0.04%。仅作用于趋势自动账户（trend-auto-v1）：经 PaperEngine 实例属性
   *  feeRate 注入生效（paperEngineFor 第二参），开仓预检与引擎结算共用同一实例费率，
   *  绝不与预检口径脱钩。手动模拟盘 default 账户不受影响，仍为 PaperEngine 默认
   *  Taker 0.05%（futures.ts TAKER_FEE）。代码常量、非控制台项（如需运行时可调另行扩展）。 */
  FEE_RATE: 0.0002,

  // ===== 决策节奏 =====
  /** 主循环周期：MFE/MAE 采集 + 退出管理 + 强平巡检 + 开仓决策（独立任务，不依赖页面访问） */
  SCAN_MS: 10_000,
  /** 单笔最小保证金（与手动盘一致，低于则跳过并记录原因） */
  MIN_MARGIN: 2,

  // ===== 开仓门控 =====
  /** 允许开仓的相位（候选趋势不能开仓，必须达到确认门槛） */
  CONFIRMED_PHASES: ['CONFIRMED_UP', 'CONFIRMED_DOWN'] as const,
  /** 反转后新方向开仓要求：确认评估包含的已收盘 K 线必须晚于该 symbol 上一笔平仓时刻
   *  （「先平后开」独立性——同一根 K 线不既触发平仓又触发反向开仓） */
  REVERSE_INDEPENDENT_BARS: true,

  // ===== 入场质量门槛（Task 56 §5.1/§5.2 → Task 57 起移交策略全权判定） =====
  /** ⚠️ 本文件不再保留 score/ER/HTF 门槛常量（原 ENTRY_MIN_SCORE/ENTRY_MIN_ER/
   *  ENTRY_HTF_STRICT_* 已删）——入场门槛现由策略插件自管，唯一调参入口：
   *  strategy/short-swing.ts 的 SHORT_SWING（模式 A score≥45 / 模式 B score≥55）。
   *  在这里改门槛不会生效。 */

  // ===== Task 56：待入场二次确认（§5.3）与冷却（§5.4） =====
  /** 首次确认后等待下一根已收盘 K 线再开仓；待入场记录超过该时长未成交则取消
   *  （防陈旧信号；重启从 DB 恢复后同样按此判过期） */
  PENDING_EXPIRE_MS: 10 * 60_000,
  /** 同一币种平仓后冷却：冷却期内新信号只记录不执行；到期后重新走完整入场门槛 */
  COOLDOWN_MS: 5 * 60_000,

  // ===== Task 57：可插拔策略 =====
  /** 默认策略 id（TrendAutoConfig.strategyId 播种值；注册表见 strategy/registry.ts） */
  DEFAULT_STRATEGY_ID: 'short-swing-v1',
} as const;

/** 自动账户运行模式（TrendAutoConfig.mode） */
export type TrendAutoMode = 'RUNNING' | 'PAUSED' | 'STOPPED';

/**
 * 实际生效的每仓保证金比例（Task 65 动态槽位配额）。
 * = min(用户上限, 95% ÷ (当前持仓数+1))——本仓占用第 openCount+1 个槽位：
 * 单仓（openCount=0）→ min(cap, 95%)，cap=0.95 时即满配开最大仓；
 * 并发越多槽位越碎（2 仓时新仓 47.5%、3 仓时 31.7%…），资金按剩余配额自动均分。
 * openCount 异常（负数/NaN）按 0 处理（回退单仓槽位，绝不放大比例）。
 * 唯一消费点：auto-trader executeOpen 仓位测算（pending 转换与直开共用，单点生效）。
 */
export function effectiveMarginRatio(marginRatioCap: number, openCount: number): number {
  const slot = Math.max(Math.floor(openCount) || 0, 0) + 1;
  return Math.min(marginRatioCap, TREND_TRADE.MARGIN_SLOT_HEADROOM / slot);
}

/** 平仓原因（TrendTradeMeta.exitReason；细分的模型结束原因见 TrendTradeMeta.exitEndReason） */
export type TrendExitReason =
  | 'TREND_ENDED' // 趋势确认结束（三根独立收盘 K 线证据 / 周期匹配）
  | 'REVERSE_CONFIRMED' // 反向趋势确认，关闭原方向持仓
  | 'SPIKE_TAKE' // Task 57 策略离场：冲高/下杀短窗快速运动，浮盈及时落袋
  | 'WEAKNESS_EARLY' // Task 57 策略离场：短周期走弱（END_PENDING 同周期）先走，走强可再入场
  | 'LIQUIDATED' // 强平（杠杆模拟执行结果，不伪装模型止损）
  | 'MANUAL'; // 人工平仓 / 全部平仓 / 换仓数量调整 / 切换算法清场

/** 高周期方向状态（§5.2：与 1m 趋势方向比较后的分级） */
export type HtfGateState = 'ALIGNED' | 'NEUTRAL' | 'OPPOSED' | 'INVALID';

/** 待入场记录状态（TrendPendingEntry.status） */
export type PendingEntryStatus = 'ACTIVE' | 'CONVERTED' | 'CANCELED';
