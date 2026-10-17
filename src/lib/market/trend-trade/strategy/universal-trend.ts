// ---------- 策略：通用趋势引擎 v1（universal-trend-v1，Task 62：最开始的 UTE 算法化） ----------
//
// 血缘（这是系统最开始的趋势算法）：vendor/universal-trend-engine = 最初的趋势判定内核
// ——五因子证据分（区间收益 0.35 / 方向一致性 0.25 / 突破 0.20 / 量能 0.15 / 振幅扩张 0.05
// + 异动加成 3 分）+ 候选→确认状态机（连续 3 根已收盘 1m K 线同向证据才确认）。
// 该内核至今仍是唯一趋势来源（trend-watch/service 消费 vendor 包产出 UnifiedTrendSignal，
// 纪律：绝不出现第二套方向算法），本策略 = 在这份信号之上的「UTE 直通车」决策层：
// 信号确认了就顺着做，确认还在就拿着，确认走弱就先走——不添加 UTE 之外的任何判断。
//
// 与「短周期套利」(short-swing-v1) 的区别（用户对比用，2026-10-17）：
// ┌────────────┬──────────────────────────────┬────────────────────────────────┐
// │ 维度        │ 通用趋势引擎（本策略）           │ 短周期套利（short-swing-v1）      │
// ├────────────┼──────────────────────────────┼────────────────────────────────┤
// │ 入场条件    │ 1m 确认即入场（纯确认制，        │ 确认 + 评分/ER 双门槛 + 5m 背景    │
// │            │ ENTRY_MIN_SCORE 默认 0）        │ 分级（同向波段/震荡选向/反向不做）  │
// │ 5m 背景     │ 不设门槛（单一标的自足，          │ 硬过滤：反向拒绝、震荡选向加严      │
// │            │ 仅在审计留档）                   │                                │
// │ 冲高落袋    │ 无（确认在就拿满周期）            │ SPIKE_TAKE 短窗脉冲落袋           │
// │ 离场        │ 走弱先走（END_PENDING 同周期）    │ 冲高落袋 / 走弱先走（先落袋后走弱）  │
// │ 持仓风格    │ 趋势跟随：拿整个确认周期           │ 短窗口脉冲套利：快进快出            │
// └────────────┴──────────────────────────────┴────────────────────────────────┘
//
// 控制台参数（用户定版 2026-10-17）：暂不注册 PARAM_DEFS，使用下方代码默认——参数结构
// 已按「UTE_ 可覆盖」设计（构造器 withDefaults），将来要开放控制台按 docs/strategy-interface.md
// §6.3 三步即可（键前缀 UTE_ 与 short-swing 的键天然不撞）。
//
// 红线：纯模拟；阈值为忠实 UTE 原味的工程初值、未经历史回放校准，不构成盈利能力声明；
// 强平/ENDED 周期匹配/反向确认/二次确认/冷却等基础设施规则不受本策略影响。

import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendExitReason } from '../config';
import type { TrendTradeMetaRow } from '../repo';
import type {
  StrategyEntryVerdict,
  StrategyExitVerdict,
  StrategyMarketCtx,
  StrategyPositionCtx,
  TrendStrategy,
} from './types';

/** 通用趋势引擎 v1 · 全部可调参数（唯一调参入口；忠实 UTE 原味的默认值） */
export const UNIVERSAL_TREND = {
  /** 入场评分下限（0 = 纯确认制：UTE 确认状态机已要求连续 3 根同向收盘证据，不再加门槛；
   *  调高可挡「刚过确认线的弱证据」杂音——这是 UTE 与短周期套利最大的差异旋钮） */
  ENTRY_MIN_SCORE: 0,
  /** 同一趋势周期最大开仓轮次（首次 + 走弱后走强的再入场；防同周期无限磨损的护栏） */
  MAX_ROUNDS_PER_CYCLE: 2,
  /** 同周期再入场最小间隔（上次平仓 → 下次评估开仓，防同一根 K 线内反复进出） */
  REENTRY_MIN_GAP_MS: 60_000,
  /** 走弱是否提前离场（true = END_PENDING 同周期即走，配合轮次再入场——UTE 语义
   *  「确认不在即离场」；false = 等 ENDED/反向确认/强平的纯持有版，回撤可能更深） */
  WEAKNESS_EXIT_EARLY: true,
};

export type UniversalTrendParams = Partial<typeof UNIVERSAL_TREND>;

/** 合并参数（构造器覆盖；未指定项用默认） */
function withDefaults(p?: UniversalTrendParams): typeof UNIVERSAL_TREND {
  return { ...UNIVERSAL_TREND, ...(p ?? {}) };
}

/** 单 symbol 策略状态（持久化到 TrendStrategyState.stateJson；重启恢复轮次语义） */
interface SymbolState {
  /** 当前（或最近一次）交易的趋势周期 */
  cycleId: string | null;
  /** 该周期已完成的第几轮开仓 */
  round: number;
  /** 最近一次开仓依据的已收盘 K 线（再入场要求出现更新的 K 线） */
  lastEntryBar: number | null;
  /** 最近一次平仓时刻（ms） */
  lastExitAt: number | null;
  /** 最近一次平仓原因 */
  lastExitReason: string | null;
}

export class UniversalTrendStrategy implements TrendStrategy {
  readonly id = 'universal-trend-v1';
  readonly name = '通用趋势引擎';
  readonly description =
    '最开始的 Universal Trend Engine 直通车：1m 确认即顺势入场（不设评分/ER/5m 门槛），' +
    '确认在就拿满周期、走弱先走（走强可再入场 ≤2 轮）；无冲高落袋';

  /** 可调参数（构造器覆盖；生产默认值 = UTE 原味） */
  readonly params: typeof UNIVERSAL_TREND;

  private states = new Map<string, SymbolState>();
  /** 状态变化回调（AutoPaperTrader 注入：持久化到 TrendStrategyState） */
  private onStateChange: ((strategyId: string, symbol: string, json: string) => void) | null = null;

  constructor(params?: UniversalTrendParams) {
    this.params = withDefaults(params);
  }

  bindPersistence(fn: (strategyId: string, symbol: string, json: string) => void): void {
    this.onStateChange = fn;
  }

  // ============ 行情采样 ============
  // UTE 直通车刻意不采样 tick 级价格：决策输入全部来自 UnifiedTrendSignal（已收盘 K 线
  // 证据）——「信号怎么说就怎么做」是该算法的身份；冲高检测等 tick 级玩法属短周期套利。

  observe(_symbol: string, _mark: number, _now: number): void {
    // 空实现：见上注释
  }

  // ============ 入场评估（确认即顺势；门槛只有轮次/间隔/新K线三道防磨损护栏） ============

  evaluateEntry(signal: UnifiedTrendSignal, _ctx: StrategyMarketCtx): StrategyEntryVerdict {
    const sym = signal.symbol;
    // ① UTE 确认状态机：仅确认相位可入场（候选/观察/结束中 = 方向证据不足，不交易）
    if (signal.phase !== 'CONFIRMED_UP' && signal.phase !== 'CONFIRMED_DOWN') {
      return {
        want: false, side: null, modeTag: '-',
        reason: `UTE 未确认（phase=${signal.phase}），确认状态机要求连续 3 根同向收盘证据`,
      };
    }
    const side: 'LONG' | 'SHORT' = signal.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';

    // ② 轮次约束：同周期走强再入场有上限（新周期自动从 1 开始；防同周期无限磨损）
    const st = this.states.get(sym);
    const sameCycle = st != null && st.cycleId === signal.trendCycleId;
    const nextRound = this.nextRound(sym, signal.trendCycleId ?? '');
    if (signal.trendCycleId && nextRound > this.params.MAX_ROUNDS_PER_CYCLE) {
      return {
        want: false, side: null, modeTag: '-',
        reason: `本趋势周期轮次已用尽（${st?.round}/${this.params.MAX_ROUNDS_PER_CYCLE}），防同周期反复磨损`,
      };
    }
    // ③ 同周期再入场间隔：刚离场不久不给立刻接回（等新证据积累）
    if (sameCycle && st?.lastExitAt != null && Date.now() - st.lastExitAt < this.params.REENTRY_MIN_GAP_MS) {
      return { want: false, side: null, modeTag: '-', reason: '同周期再入场间隔不足（刚离场，等待新证据）' };
    }
    // ④ 同周期再入场要求出现「上次开仓之后的新已收盘 K 线」（走强的新证据，不是旧信号回声）
    if (sameCycle && st?.lastEntryBar != null && signal.lastBarTime != null && signal.lastBarTime <= st.lastEntryBar) {
      return { want: false, side: null, modeTag: '-', reason: '同周期再入场等待新收盘 K 线（无新证据）' };
    }

    // ⑤ 评分下限（默认 0 = 纯确认制不生效；调高可挡「刚过确认线的弱证据」）
    const score = signal.score;
    if (score < this.params.ENTRY_MIN_SCORE) {
      return {
        want: false, side: null, modeTag: 'UTE_CONFIRMED',
        reason: `评分 ${score.toFixed(0)} < ${this.params.ENTRY_MIN_SCORE}（UTE 评分下限）`,
      };
    }

    // 放行：纯确认制顺势单。5m 背景与 ER 仅留档（UTE 不设门槛——单一标的自足哲学，
    // 与短周期套利的本质区别之一；这些值进审计供事后对比分析）
    const h5dir = signal.htf5m.valid ? signal.htf5m.dir : '数据不足';
    return {
      want: true, side, modeTag: 'UTE_CONFIRMED',
      reason:
        `UTE 确认即顺势（${side === 'LONG' ? '确认上涨' : '确认下跌'}）score=${score.toFixed(0)} ` +
        `er=${signal.features.efficiencyRatio.toFixed(2)}（5m 背景 ${h5dir} 仅留档不设门）` +
        `${nextRound > 1 ? ` 轮次#R${nextRound}` : ''}`,
    };
  }

  // ============ 离场评估（走弱先走；无冲高落袋——确认在就拿满周期） ============

  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: StrategyPositionCtx;
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    const { meta, signal } = input;

    // 走弱先走：本周期出现结束迹象即离场（UTE 语义「确认不在即离场」的宽限版——
    // END_PENDING 底层方向仍成立，比直接掉头温和；走强回确认后按轮次再入场。
    // 异周期 END_PENDING 与本持仓无关，绝不误平）
    if (this.params.WEAKNESS_EXIT_EARLY && signal && signal.phase === 'END_PENDING') {
      if (signal.trendCycleId && signal.trendCycleId === meta.trendCycleId) {
        return {
          exit: true,
          reason: 'WEAKNESS_EARLY' as TrendExitReason,
          detail: `UTE 确认走弱先走（END_PENDING 证据 ${signal.endEvidenceBars} 根），走强回确认可再入场`,
        };
      }
    }
    // WEAKNESS_EXIT_EARLY=false：无策略性离场——等基础设施 ENDED 周期匹配 / 反向确认 /
    // 强平处理（纯持有版：确认在就拿满整个周期）

    return { exit: false, reason: null, detail: '' };
  }

  // ============ 轮次状态（与 short-swing 同构；基础设施幂等键 {cycleId}#R{round} 依赖） ============

  nextRound(symbol: string, cycleId: string): number {
    const st = this.states.get(symbol);
    if (!st || !cycleId) return 1;
    return st.cycleId === cycleId ? st.round + 1 : 1;
  }

  onOpen(symbol: string, cycleId: string, barTime: number | null, now: number): void {
    const prev = this.states.get(symbol);
    const st: SymbolState =
      prev && prev.cycleId === cycleId
        ? { ...prev, round: prev.round + 1 }
        : { cycleId, round: 1, lastEntryBar: null, lastExitAt: null, lastExitReason: null };
    st.lastEntryBar = barTime;
    this.states.set(symbol, st);
    this.flush(symbol);
  }

  onClose(symbol: string, cycleId: string, reason: string, now: number): void {
    const prev = this.states.get(symbol);
    if (prev && prev.cycleId === cycleId) {
      this.states.set(symbol, { ...prev, lastExitAt: now, lastExitReason: reason });
      this.flush(symbol);
    }
    // 周期不匹配（旧周期残响）：不动轮次状态
  }

  // ============ 持久化 ============

  exportState(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [sym, st] of this.states) out[sym] = st;
    return out;
  }

  importState(raw: unknown): void {
    this.states.clear();
    if (!raw || typeof raw !== 'object') return;
    for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const o = v as Partial<SymbolState>;
      if (typeof o.cycleId !== 'string' || typeof o.round !== 'number') continue;
      this.states.set(sym, {
        cycleId: o.cycleId,
        round: o.round,
        lastEntryBar: typeof o.lastEntryBar === 'number' ? o.lastEntryBar : null,
        lastExitAt: typeof o.lastExitAt === 'number' ? o.lastExitAt : null,
        lastExitReason: typeof o.lastExitReason === 'string' ? o.lastExitReason : null,
      });
    }
  }

  private flush(symbol: string): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(this.id, symbol, JSON.stringify(this.states.get(symbol) ?? {}));
    } catch {
      // 持久化失败不影响决策（状态仍在内存；重启后轮次可能回退一档——可接受）
    }
  }
}
