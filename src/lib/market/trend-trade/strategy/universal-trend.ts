// ---------- 策略：通用趋势引擎 v1（universal-trend-v1，Task 62 上架 / Task 66 复盘定版） ----------
//
// 血缘（这是系统最开始的趋势算法）：vendor/universal-trend-engine = 最初的趋势判定内核
// ——五因子证据分（区间收益 0.35 / 方向一致性 0.25 / 突破 0.20 / 量能 0.15 / 振幅扩张 0.05
// + 异动加成 3 分）+ 候选→确认状态机（连续 3 根已收盘 1m K 线同向证据才确认）。
// 该内核至今仍是唯一趋势来源（trend-watch/service 消费 vendor 包产出 UnifiedTrendSignal，
// 纪律：绝不出现第二套方向算法），本策略 = 在这份信号之上的决策层。
//
// Task 68 用户定版（2026-10-18）——「通用趋势引擎的持仓时间太短了，它是一个长周期的模型」：
// 线上实据：3 笔 UTE 持仓全部在 2~6.5 分钟内被三层离场逐层砍掉（WEAKNESS_EARLY -6.84U /
// STOP_LOSS / TRAIL_TAKE +1.05U）——长周期模型跑成了分钟级。三处定版：
// ① WEAKNESS_EXIT_EARLY true→false（长周期核心）：END_PENDING 走弱迹象只是趋势「可能」
//   结束的前兆（单根噪声也能触发证据），不再触发离场——持有到基础设施 ENDED（周期真正
//   结束，3 根独立收盘证据确认）/ 反向确认 / 强平。「确认在就拿满整个周期」是本算法身份。
// ② 硬止损 1.0%→1.5%（价格口径）：1.0% 恰好贴着生命周期自身的容忍回撤带
//   （minMovePct×2.5 = 0.875%）——趋势内正常回撤贴近容忍带上沿就会把长周期持仓扫掉，
//   等于「稍微回调就止损」的残留；1.5% 让止损住在趋势模型自身容忍的噪声带之外
//   （20x 下 = -30% 保证金，仍远早于强平线 ~5%）。
// ③ 移动止盈 15/8→30/20（保证金口径）：15/8 = 0.75% 价格冲高即激活、0.4% 回吐即落袋，
//   是分钟级脉冲尺度（线上那笔 TRAIL_TAKE 持仓 2 分钟）；30/20 = 1.5% 价格启动保护、
//   1.0% 价格回吐落袋——回吐线同样住在容忍带（0.875%）之外，趋势内正常回调不打断持仓，
//   只有真正兑现过大段利润后才开始保护（净锁利下限 = 峰值 30% - 回吐 20% = 10% 保证金）。
// WEAKNESS_MIN_EVIDENCE_BARS 保留：WEAKNESS_EXIT_EARLY 重开（true）时仍生效。
//
// Task 66 用户定版（2026-10-17 复盘）——旧版两个问题与修复：
// ①「建仓点位是提前预判，比如不是震荡之后的方向选择，就容易追涨/追空」
//   → 入场改为「震荡后方向选择确认制」（REQUIRE_DIRECTION_PICK）：确认之外还要求
//     features.breakout 与方向一致（收盘价刚越出近期区间高/低点 = 字面意义的「震荡之后
//     的方向选择」）或 ER ≥ ENTRY_MIN_ER（突破后 1-2 根的单边延续段）；两者皆无 =
//     震荡区间内部的噪声确认（预判性入场），拒绝。
// ②「止盈止损门槛需要合理设置：已有盈利的情况下多少止盈、多少止损；出现了稍微回调一点
//   就止损的情况，不合理」
//   → 离场三层化：
//     a) 硬止损 STOP_LOSS_PCT=1.0%（价格口径）：方向选择失败的单子砍在 -20% 保证金
//        @20x，不拖到强平；对 1m 常态回调（ATR% 0.2~0.4%）足够宽容，不会被小回调扫掉。
//     b) 移动止盈 TRAIL_ARM_PCT=15% / TRAIL_GIVEBACK_PCT=8%（保证金口径）：浮盈 ≥15%
//        激活，从峰值回撤 ≥8% 落袋（TRAIL_TAKE）——不设固定止盈线（趋势要拿大段），
//        但利润回吐有底线。
//     c) 走弱先走需 WEAKNESS_MIN_EVIDENCE_BARS=2 根证据：旧版 END_PENDING 第一根证据
//        即割（单根噪声 = 「稍微回调一点就止损」的根源）；2 根 = 连续两根独立收盘 K 线
//        持续走弱，仍早于 ENDED 的 3 根确认。
//
// 与「短周期套利」(short-swing-v1) 的区别（Task 66 版）：
// ┌──────────┬──────────────────────────────────┬──────────────────────────────┐
// │ 维度      │ 通用趋势引擎（本策略）              │ 短周期套利（short-swing-v1）    │
// ├──────────┼──────────────────────────────────┼──────────────────────────────┤
// │ 入场条件  │ 确认 + 震荡后方向选择证据（突破同向  │ 确认 + 评分/ER 双门槛 + 5m 背景 │
// │          │ 或 ER 单边延续）                   │ 分级（同向波段/震荡选向/反向不做）│
// │ 止盈      │ 移动止盈：峰值 30% 后回撤 20% 落袋   │ SPIKE_TAKE 冲高脉冲落袋（0.4%） │
// │ 止损      │ 硬止损 1.5% 价格（≈30% 保证金 @20x） │ 无（走弱先走/ENDED/强平兜底）    │
// │ 走弱离场  │ 不离场（长周期：持有到 ENDED/反向）  │ END_PENDING 即走（1 根证据）     │
// │ 持仓风格  │ 长周期趋势跟随：拿满周期大段         │ 短窗口脉冲套利：快进快出         │
// └──────────┴──────────────────────────────────┴──────────────────────────────┘
//
// 控制台参数（用户定版 2026-10-17）：暂不注册 PARAM_DEFS，使用代码默认——参数结构已按
// 「UTE_ 可覆盖」设计（构造器 withDefaults），将来要开放控制台按 docs/strategy-interface.md
// §6.3 三步即可（键前缀 UTE_ 与 short-swing 的键天然不撞）。
//
// 红线：纯模拟；阈值为复盘定版的工程初值、未经历史回放校准，不构成盈利能力声明；
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

/** 通用趋势引擎 v1 · 全部可调参数（唯一调参入口；Task 66 复盘定版：方向选择确认制 + 三层离场） */
export const UNIVERSAL_TREND = {
  /** 入场评分下限（0 = 纯确认制：UTE 确认状态机已要求连续 3 根同向收盘证据，不再加门槛；
   *  调高可挡「刚过确认线的弱证据」杂音——这是 UTE 与短周期套利最大的差异旋钮） */
  ENTRY_MIN_SCORE: 0,
  /** 震荡后方向选择确认制（用户定版 2026-10-17 复盘：「顺着震荡之后的方向选择的方向来做多
   *  或者做空，而不是提前对趋势进行预判性做多或者做空」）：true = 确认之外还要求「方向选择」
   *  证据——features.breakout 与方向一致（收盘价刚越出近期区间高/低点 = 字面意义的
   *  「震荡之后的方向选择」）或 ER ≥ ENTRY_MIN_ER（突破后 1-2 根的单边延续段）；
   *  两者皆无 = 震荡区间内部的噪声确认（预判性入场），拒绝。false = 旧版纯确认制 */
  REQUIRE_DIRECTION_PICK: true,
  /** 方向选择延续段的 ER 下限：突破标记只在突破瞬间出现，突破后 1-2 根收盘 ER 仍高
   *  （走势高度单边）同样视为「方向选择进行中」；无突破伴随且低于该线 = 震荡噪声 */
  ENTRY_MIN_ER: 0.3,
  /** 同一趋势周期最大开仓轮次（首次 + 走弱后走强的再入场；防同周期无限磨损的护栏） */
  MAX_ROUNDS_PER_CYCLE: 2,
  /** 同周期再入场最小间隔（上次平仓 → 下次评估开仓，防同一根 K 线内反复进出） */
  REENTRY_MIN_GAP_MS: 60_000,
  /** 硬止损（价格 %，用户定版「多少止损」）：开仓后价格逆行 ≥ 该值立即止损。Task 68
   *  长周期定版 1.0→1.5：1.0% 恰好贴着生命周期自身的容忍回撤带（minMovePct×2.5=0.875%），
   *  趋势内正常回撤贴近带上沿就扫掉长周期持仓（「稍微回调就止损」的残留）；1.5% 让止损
   *  住在趋势模型自身容忍的噪声带之外（20x 下 = -30% 保证金，仍远早于强平线 ~5%）。
   *  0 = 关闭（不推荐——20x 下无止损的单子 5% 逆行即近爆仓） */
  STOP_LOSS_PCT: 1.5,
  /** 移动止盈激活线（保证金 %，用户定版「已有盈利的情况下多少止盈」）：浮盈 ≥ 该值后
   *  启用利润回撤保护。Task 68 长周期定版 15→30：30% 保证金 = 1.5% 价格 @20x——只有
   *  真正兑现过大段利润才启动保护（15% = 0.75% 价格是分钟级脉冲尺度，2 分钟即落袋） */
  TRAIL_ARM_PCT: 30,
  /** 移动止盈回撤线（保证金 %）：激活后从持仓期峰值浮盈回撤 ≥ 该值 → 落袋（TRAIL_TAKE）
   *  ——趋势模型的「利润兑现」：不设固定止盈线（要拿趋势大段），但利润回吐有底线。
   *  Task 68 长周期定版 8→20：20% 保证金 = 1.0% 价格 @20x，大于生命周期容忍回撤带
   *  （0.875% 价格）——趋势内正常回调不触发；净锁利下限 = 30-20 = 10% 保证金。0 = 关闭 */
  TRAIL_GIVEBACK_PCT: 20,
  /** 走弱先走最小证据根数（用户定版 2026-10-17 复盘：修复「稍微回调一点就止损」的不合理
   *  离场）：END_PENDING 结束证据（不同已收盘 K 线）≥ 该根数才先走——1 根证据可能是单根
   *  噪声（旧版第一根就割在回撤深处），2 根 = 连续两根独立 K 线持续出现结束证据，仍早于
   *  ENDED 的 3 根确认，保留「先走」优势又给趋势一根 K 线的容忍度 */
  WEAKNESS_MIN_EVIDENCE_BARS: 2,
  /** 走弱是否提前离场（Task 68 长周期定版默认 false：END_PENDING 走弱迹象只是趋势
   *  「可能」结束的前兆，不再触发离场——持有到基础设施 ENDED（周期真正结束）/反向确认/
   *  强平，「确认在就拿满整个周期」；true = END_PENDING 证据 ≥WEAKNESS_MIN_EVIDENCE_BARS
   *  根即走、走强可再入场的快周期版，回撤保护更强但持仓时间显著更短） */
  WEAKNESS_EXIT_EARLY: false,
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
    'Universal Trend Engine 长周期趋势跟随（Task 68 定版）：1m 确认 + 震荡后方向选择证据' +
    '（区间突破同向或 ER 单边延续）才入场，不做预判性单；确认在就拿满整个周期（走弱不离场，' +
    '等 ENDED/反向），硬止损 1.5% 价格、移动止盈（峰值浮盈 30% 后回撤 20% 落袋）';

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

    // ⑥ 震荡后方向选择确认制（用户定版 2026-10-17 复盘）：确认 ≠ 可交易——UTE 的确认
    //    也可能发生在震荡区间内部（区间内连续 3 根同向收盘即确认），那是用户指出的
    //    「提前对趋势进行预判性做多/做空」；只在「震荡之后的方向选择」上顺势：
    //    a) 突破证据：features.breakout 与方向一致（收盘价刚越出近期区间高/低点）
    //    b) 延续证据：ER ≥ ENTRY_MIN_ER（突破后 1-2 根的单边延续段——突破标记已回落
    //       但走势仍高度单边 = 方向选择进行中）
    //    两者皆无 = 区间内噪声确认，等真正的方向选择（属于预判性入场，拒绝）
    const er = signal.features.efficiencyRatio;
    if (this.params.REQUIRE_DIRECTION_PICK) {
      const dir = signal.direction;
      const bo = signal.features.breakout;
      const byBreakout = (dir === 'up' && bo === 'up') || (dir === 'down' && bo === 'down');
      const byContinuation = er >= this.params.ENTRY_MIN_ER;
      if (!byBreakout && !byContinuation) {
        return {
          want: false, side: null, modeTag: 'NO_DIRECTION_PICK',
          reason: `震荡内噪声确认（breakout=${bo}、ER ${er.toFixed(2)} < ${this.params.ENTRY_MIN_ER}）：等震荡之后的方向选择再顺势，不做预判性入场`,
        };
      }
    }

    // 放行：确认 + 方向选择证据的顺势单。5m 背景仅留档（UTE 不设背景门槛——单一标的
    // 自足哲学，与短周期套利的本质区别之一；这些值进审计供事后对比分析）
    const h5dir = signal.htf5m.valid ? signal.htf5m.dir : '数据不足';
    const bo = signal.features.breakout;
    const pickDesc =
      (signal.direction === 'up' && bo === 'up') || (signal.direction === 'down' && bo === 'down')
        ? `区间突破（${bo}）`
        : `单边延续 ER=${er.toFixed(2)}`;
    return {
      want: true, side, modeTag: 'UTE_CONFIRMED',
      reason:
        `UTE 确认 + 方向选择（${pickDesc}）顺势${side === 'LONG' ? '做多' : '做空'} score=${score.toFixed(0)} ` +
        `er=${er.toFixed(2)}（5m 背景 ${h5dir} 仅留档不设门）` +
        `${nextRound > 1 ? ` 轮次#R${nextRound}` : ''}`,
    };
  }

  // ============ 离场评估（三层：硬止损 → 利润回撤保护 → 走弱先走证据达标版） ============
  // Task 66 用户定版 2026-10-17 复盘：旧版只有「走弱先走」一层（END_PENDING 一根证据
  // 即割 = 「稍微回调一点就止损」的不合理离场），且无止盈无止损（长周期大盈大亏）。
  // 现为：① 硬止损（回答「多少止损」）② 移动止盈（回答「已有盈利的情况下多少止盈」）
  // ③ 走弱先走（证据 ≥2 根才走，修复单根噪声即割）；ENDED/反向/强平仍由基础设施处理。

  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: StrategyPositionCtx;
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    const { meta, pos, mark, signal } = input;
    const sign = pos.side === 'LONG' ? 1 : -1;

    // ① 硬止损：价格逆行 ≥ STOP_LOSS_PCT（价格 %）→ 止损。趋势确认不等于价格不逆行——
    //    方向选择失败的持仓不允许拖到强平（20x 下 5% 逆行即近爆仓线）。口径 = 价格 %：
    //    evaluateExit 无杠杆上下文，与杠杆解耦的绝对尺度更可解释（1% ≈ 20x 下 20% 保证金）
    if (this.params.STOP_LOSS_PCT > 0 && pos.entryPrice > 0) {
      const adversePct = ((pos.entryPrice - mark) / pos.entryPrice) * 100 * sign;
      if (adversePct >= this.params.STOP_LOSS_PCT) {
        return {
          exit: true,
          reason: 'STOP_LOSS',
          detail: `硬止损：价格逆行 ${adversePct.toFixed(2)}% ≥ ${this.params.STOP_LOSS_PCT}%（方向选择失败，防拖到强平）`,
        };
      }
    }

    // ② 利润回撤保护（移动止盈）：浮盈曾达 TRAIL_ARM_PCT（保证金 %）激活后，从峰值回撤
    //    ≥ TRAIL_GIVEBACK_PCT → 落袋（TRAIL_TAKE）。不设固定止盈线（趋势要拿大段），但
    //    利润回吐有底线。峰值 = max(meta.mfe[上一 tick 落库的持仓期峰值], 当前实时浮盈)
    //    ——当前 tick 刚创新高时立即按新峰值生效，不等下一 tick 落库
    if (this.params.TRAIL_ARM_PCT > 0 && this.params.TRAIL_GIVEBACK_PCT > 0 && pos.margin > 0) {
      const livePnlPct = ((mark - pos.entryPrice) * pos.qty * sign / pos.margin) * 100;
      const peak = Math.max(meta.mfe ?? 0, livePnlPct);
      if (peak >= this.params.TRAIL_ARM_PCT) {
        const giveback = peak - livePnlPct;
        if (giveback >= this.params.TRAIL_GIVEBACK_PCT) {
          return {
            exit: true,
            reason: 'TRAIL_TAKE',
            detail: `移动止盈：峰值浮盈 ${peak.toFixed(1)}% ≥ ${this.params.TRAIL_ARM_PCT}% 后回撤 ${giveback.toFixed(1)}% ≥ ${this.params.TRAIL_GIVEBACK_PCT}%，锁定利润离场`,
          };
        }
      }
    }

    // ③ 走弱先走（证据达标版）：本周期 END_PENDING 结束证据 ≥ WEAKNESS_MIN_EVIDENCE_BARS
    //    根（不同已收盘 K 线）才先走——1 根证据可能是单根噪声（旧版即割 = 「稍微回调一点
    //    就止损」），2 根 = 连续两根独立 K 线持续走弱，仍早于 ENDED 的 3 根确认；走强回
    //    确认后按轮次再入场。异周期 END_PENDING 与本持仓无关，绝不误平
    if (
      this.params.WEAKNESS_EXIT_EARLY &&
      signal &&
      signal.phase === 'END_PENDING' &&
      signal.endEvidenceBars >= this.params.WEAKNESS_MIN_EVIDENCE_BARS
    ) {
      if (signal.trendCycleId && signal.trendCycleId === meta.trendCycleId) {
        return {
          exit: true,
          reason: 'WEAKNESS_EARLY' as TrendExitReason,
          detail: `UTE 确认走弱先走（END_PENDING 证据 ${signal.endEvidenceBars} 根 ≥ ${this.params.WEAKNESS_MIN_EVIDENCE_BARS}），走强回确认可再入场`,
        };
      }
    }
    // WEAKNESS_EXIT_EARLY=false：策略性离场只剩 ①②——等基础设施 ENDED 周期匹配 /
    // 反向确认 / 强平处理（纯持有版：确认在就拿满整个周期）

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
