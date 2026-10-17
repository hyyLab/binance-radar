// ---------- 趋势自动交易 · 通用策略接口（Task 57：算法可插拔） ----------
// 设计目标（用户定版）：把「怎么选标的、怎么定方向、何时开仓、何时离场」从 AutoPaperTrader
// 的基础设施中剥离为可替换的策略插件——异动选币（候选池）+ 账户/资金/幂等/二次确认/
// 冷却/强平/MFE 统计等基础设施由 AutoPaperTrader 统一提供，策略只做「决策」。
//
// 纪律：
// - 策略绝不接触真实下单；所有决策仅作用于独立模拟账户 trend-auto-v1。
// - 策略只能基于「当时可用」的数据决策（mark 价为当前 tick 快照、信号为已收盘 K 线
//   评估结果），禁止任何形式的未来数据。
// - 基础设施保留的硬性安全规则优先于策略：ENDED 周期匹配离场、反向确认离场、强平、
//   暂停停新开仓、数据过期停新开仓、待入场二次确认流程——策略在这些规则之内表达个性。
// - 轮次（round）：同一 trendCycleId 内允许多轮「开仓→平仓→再入场」（走弱先走、走强
//   再进，用户定版），每轮决策/待入场键 = `{cycleId}#R{round}`，轮次上限由策略约束。

import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { Candle1m } from '../../enhanced/klines';
import type { EnhancedEventDTO } from '../../enhanced/types';
import type { TrendExitReason } from '../config';
import type { TrendAutoConfigRow, TrendTradeMetaRow } from '../repo';

/** 每轮 tick 提供给策略的市场/账户上下文（全部为当前时刻快照，无未来数据） */
export interface StrategyMarketCtx {
  now: number;
  /** 当前标记价（多源供价快照；>0 保证可用） */
  mark: number;
  /** 账户配置（模式/杠杆/持仓上限等运行时真值） */
  cfg: TrendAutoConfigRow;
  /** 账户权益快照 */
  equity: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number };
  /** 当前有 OPEN 持仓的 symbol 集合 */
  openSymbols: Set<string>;
  /** 该 symbol 最近一次平仓时刻（ms；null = 从未平仓） */
  lastCloseAt: number | null;
}

/** 入场评估结论 */
export interface StrategyEntryVerdict {
  /** true = 希望开仓（AutoPaperTrader 随后走「待入场 → 新收盘 K 线二次复核」流程） */
  want: boolean;
  /** 方向（want=true 时必有） */
  side: 'LONG' | 'SHORT' | null;
  /** 入场模式标签（审计/展示，如 TREND_ALIGNED / RANGE_DIRECTION） */
  modeTag: string;
  /** 拒绝原因或入场理由（中文，进审计日志） */
  reason: string;
  /** Fraction of configured per-position margin; event strategies may reduce this by shape. */
  riskMultiplier?: number;
}

/** Direct event data for strategies triggered by live MAJOR P1 anomalies rather than UTE signals. */
export interface StrategyMajorEventEntryInput {
  event: EnhancedEventDTO;
  candles: Candle1m[];
  quoteVolume24h: number;
  ctx: StrategyMarketCtx;
}

/** Event entry has an event-scoped idempotency cycle and an audit snapshot. */
export interface StrategyMajorEventEntryVerdict extends StrategyEntryVerdict {
  eventCycleId: string;
  metadata: Record<string, unknown>;
}

/** 持仓上下文（策略离场评估用；来自 PaperPosition 当前快照） */
export interface StrategyPositionCtx {
  entryPrice: number;
  qty: number;
  margin: number;
  side: 'LONG' | 'SHORT';
  /** 开仓时刻（ms） */
  openedAt: number;
}

/** 离场评估结论 */
export interface StrategyExitVerdict {
  exit: boolean;
  /** 策略性离场原因（SPIKE_TAKE / WEAKNESS_EARLY 等；exit=false 时为 null） */
  reason: TrendExitReason | null;
  /** 中文理由（审计日志） */
  detail: string;
}

/** 通用策略接口 v1——新增算法 = 实现本接口 + 在 registry 注册 */
export interface TrendStrategy {
  /** 唯一 id（持久化到 TrendAutoConfig.strategyId；切换算法时用于注册表查找） */
  readonly id: string;
  /** 展示名（UI 下拉） */
  readonly name: string;
  /** 一句话说明（UI 悬浮提示） */
  readonly description: string;
  /** True when entry is driven by live anomaly events instead of trend-pool signals. */
  readonly eventDriven?: boolean;
  /** Optional event-driven entry path; shared AutoPaperTrader still owns execution and safety. */
  evaluateMajorEventEntry?(input: StrategyMajorEventEntryInput): StrategyMajorEventEntryVerdict | null;

  /**
   * 行情采样：每 tick 对池内/持仓 symbol 调用（mark>0 才会调用）。
   * 冲高检测等需要短窗价格序列的策略在此自维护样本；实现不得阻塞。
   */
  observe(symbol: string, mark: number, now: number): void;

  /** 入场评估（该 symbol 无持仓、信号 dataFresh 时调用；相位/方向门槛由策略全权定义） */
  evaluateEntry(signal: UnifiedTrendSignal, ctx: StrategyMarketCtx): StrategyEntryVerdict;

  /** 离场评估（该 symbol 有 OPEN 持仓时调用；基础设施离场规则在此之前已处理） */
  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: StrategyPositionCtx;
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict;

  /**
   * 本周期下一轮轮次号（1 = 首次开仓；同周期平仓后再开 = 2…）。
   * AutoPaperTrader 用它组装决策/待入场幂等键 `{cycleId}#R{round}`。
   */
  nextRound(symbol: string, cycleId: string): number;

  /** 开仓成功回调（维护轮次状态；lastEntryBar 用于「新证据再入场」判定） */
  onOpen(symbol: string, cycleId: string, barTime: number | null, now: number): void;

  /** 平仓成功回调（保留轮次状态供再入场判定；记录离场时刻/原因） */
  onClose(symbol: string, cycleId: string, reason: string, now: number, exitPrice?: number): void;

  /** 导出全部 symbol 状态（持久化到 TrendStrategyState；重启恢复轮次语义） */
  exportState(): Record<string, unknown>;
  /** 导入持久化状态（boot / 切换策略时；JSON 结构由各策略自定义、向后兼容自管） */
  importState(raw: unknown): void;

  /**
   * 绑定状态持久化回调（AutoPaperTrader 装配时调用一次）：策略在 onOpen/onClose
   * 等状态变化点调用它把单 symbol 状态 JSON 落库（TrendStrategyState）。
   */
  bindPersistence(fn: (strategyId: string, symbol: string, json: string) => void): void;
}

/** 策略注册表条目（UI 下拉数据源） */
export interface StrategyDescriptor {
  id: string;
  name: string;
  description: string;
}
