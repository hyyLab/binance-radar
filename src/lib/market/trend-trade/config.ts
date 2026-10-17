// ---------- 趋势自动模拟交易 · 全部可调参数（Task 54 §3） ----------
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
  /** 开仓目标保证金 = 开仓时账户权益 × 该比例（任务 §3.2 定版 20%） */
  MARGIN_RATIO: 0.2,
  /** 固定杠杆（任务 §3.2 定版 20 倍） */
  LEVERAGE: 20,
  /** 最大同时持仓数（任务建议默认 4，避免权益全被占用） */
  MAX_POSITIONS: 4,
  /** 滑点估算（基点，单边）：开/平仓各计一次，成交记录展示并计入保守净盈亏 */
  SLIPPAGE_BPS: 2,

  // ===== 决策节奏 =====
  /** 主循环周期：退出管理 + 强平巡检 + 开仓决策（独立任务，不依赖页面访问） */
  SCAN_MS: 10_000,
  /** 单笔最小保证金（与手动盘一致，低于则跳过并记录原因） */
  MIN_MARGIN: 2,

  // ===== 开仓门控 =====
  /** 允许开仓的相位（任务 §3.2：候选趋势不能开仓，必须达到确认门槛） */
  CONFIRMED_PHASES: ['CONFIRMED_UP', 'CONFIRMED_DOWN'] as const,
  /** 反转后新方向开仓要求：确认评估包含的已收盘 K 线必须晚于该 symbol 上一笔平仓时刻
   *  （「先平后开」独立性——同一根 K 线不既触发平仓又触发反向开仓） */
  REVERSE_INDEPENDENT_BARS: true,
} as const;

/** 自动账户运行模式（TrendAutoConfig.mode） */
export type TrendAutoMode = 'RUNNING' | 'PAUSED' | 'STOPPED';

/** 平仓原因（TrendTradeMeta.exitReason） */
export type TrendExitReason =
  | 'TREND_ENDED' // 趋势确认结束
  | 'REVERSE_CONFIRMED' // 反向趋势确认，关闭原方向持仓
  | 'LIQUIDATED' // 强平（杠杆模拟执行结果，不伪装模型止损）
  | 'MANUAL'; // 人工平仓 / 全部平仓
