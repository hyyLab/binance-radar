// ---------- 策略：短周期套利 v1（short-swing-v1，Task 57 用户思路算法化） ----------
//
// 用户定版思路（原文语义逐条映射）：
// ①「建仓主要是为了发现未来一段可能的趋势……异动只是帮助我们选择要做的标的，
//    至于它是向上异动还是向下异动并不是我们重点关注的」
//    → 选币完全交给异动候选池（TrendWatchService：异动/探针入池），本策略不读
//      anomaly.dir 做方向判定；方向唯一来自短周期趋势信号（1m UTE 确认状态机）。
// ②「可以在方向确定的趋势里面进行波段的套利」（模式 A · TREND_ALIGNED）
//    → 1m 趋势已确认（CONFIRMED_UP/DOWN）且 5m 背景方向同向：顺势入场做趋势内波段。
// ③「也可以在震荡的行情选择方向之后进行方向的套利」（模式 B · RANGE_DIRECTION）
//    → 5m 仍在震荡（flat/数据不足）时，1m 率先确认出方向即为交易方向（短周期先选向），
//      用比模式 A 严一档的门槛补偿背景方向缺失；绝不做 5m 反向的逆势单。
// ④「我们主要做短周期的套利就行了」
//    → 只用 1m 确认相位 + 5m 背景参考；15m 不设硬门槛（仅随信号快照留档）。
// ⑤「如果在一个短周期内部走弱，后续还能继续走强的话，再次建仓也无可厚非」
//    → 走弱（END_PENDING）即先离场（WEAKNESS_EARLY），同周期重新走强（回到 CONFIRMED
//      且出现更新的已收盘 K 线）允许按轮次再入场（#R2…，上限 MAX_ROUNDS_PER_CYCLE）。
// ⑥「虚拟币有很多冲高回落/下杀拉回的行为，所以冲高的时候可以及时进行套利」
//    → 冲高套利（SPIKE_TAKE）：持仓浮盈且短窗（SPIKE_WINDOW_MS）内标记价顺持仓方向
//      快速运动 ≥ SPIKE_MOVE_PCT 时立即落袋——针对冲高回落/下杀拉回的行为模式，
//      属于基于价格行为的动态离场，不是固定百分比止盈。
// ⑦ 趋势起点入场（用户定版 2026-10-17）：“分数不要调那么高——分数高基本上是走势非常好的
//    时候了，我们要在趋势起点入场就没有太高的分数。”
//    → score 门槛只负责挡「证据不足的杂音」，不追求「走势已经走好」：模式 A 60→45、
//      模式 B 70→55；ER 门槛保留（防震荡结构磨损，与「早」正交）。
// ⑧ 顺势而为，不做回调低吸（用户定版 2026-10-17 复盘）：“短周期套利思路的原理应该是
//    顺势而为……应该在某一个方向走强的时候去顺势，而不是在这个方向走强之后的回调去
//    做低吸。如果大趋势没有继续运行反而走了一个短期的小趋势就会止损，这很显然有问题。”
//    → 四处落地（a/c 两项后被 Task 68 ⑨ 部分放开，见下）：
//    a) MAX_ROUNDS_PER_CYCLE 2→1：同周期只做方向刚走强的第一波；走弱离场后该周期不再
//       进。旧版 R2 再入场本质 = 「走强之后的回调后入场」（回调结束反弹重新确认时进），
//       大趋势没继续反而走短期小趋势时必然止损——正是用户指出的行为；Task 65 统计
//       R2 合计 -5.63U 无优势。
//    b) ENTRY_CHASE_PCT：确认瞬间短窗内已顺向冲高 ≥ 该值 → 拒绝（方向确实走强但已到
//       脉冲末端，追入即接脉冲顶，后面的正常回调会把自己扫出去；Task 65：17 笔入场
//       即逆行的深亏单多为确认时已在脉冲顶的高分单）。
//    c) ENTRY_FRESH_MS：确认时刻（trendStartedAt）距今超窗不入场——只做「方向刚走强」
//       的第一时间顺势单，不做确认已走老之后的违和追入（容量等待恢复等场景）。
//    d) SPIKE_MOVE_PCT 0.6→0.4：复盘 7 笔浮盈卡在 0.3~0.6% 价格区间（合计 -14.82U）
//       够不到旧落袋线被走弱离场割掉；0.4% = 20x 下 8% 保证金收益，够得着。
// ⑨ 再入场解禁（用户定版 2026-10-18）："我并没有强制说只做刚走强的第一顺势单，只是
//    这样的单子具有更高的胜率而已。"
//    → MAX_ROUNDS_PER_CYCLE 1→2（放开 ⑧-a）：第一顺势单按时间顺序天然先做（胜率偏好
//      的自然体现，无需硬禁后续单）；R2 的触发事件本身就是「重新走强」（走弱离场后回
//      CONFIRMED + 出现新收盘 K 线），不是回调低吸的代名词；追入保护（⑧-b）全轮次生效。
//    → ENTRY_FRESH_MS 仅约束首轮 R1（放开 ⑧-c 的全轮次约束）：首轮偏好「刚走强」的高
//      胜率单（确认已走老的追入拒绝）；R2 的新鲜度由「重新走强」事件自身定义（新收盘
//      K 线），不受周期年龄约束——否则确认超 3 分钟后 R2 永远进不去，再入场形同虚设。
//    保留不变：冲高套利 SPIKE_TAKE（利润来源，+68.52U/31 笔）、走弱先走、SPIKE 落袋线
//    0.4%、追入保护 1.2%。
//
// 红线：纯模拟；阈值为初始工程参数、未经历史回放校准，不构成盈利能力声明；
// 强平/ENDED 周期匹配/反向确认/二次确认/冷却等基础设施规则不受本策略影响。

import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendExitReason } from '../config';
import type { TrendTradeMetaRow } from '../repo';
import type {
  StrategyEntryVerdict,
  StrategyExitVerdict,
  StrategyMarketCtx,
  TrendStrategy,
} from './types';

/** 短周期套利 v1 · 全部可调参数（唯一调参入口；未经回放校准） */
export const SHORT_SWING = {
  /** 模式 A（5m 同向·趋势波段）：1m score 下限（UTE 证据分 0-100）。
   *  用户定版（2026-10-17）：趋势起点分数不高，高分（60+）≈走势已走出来的成熟段；
   *  本门槛只挡杂音不追「已走好」，45≈候选池入池线（40）上方一档，确认瞬间通常可达。 */
  ENTRY_MIN_SCORE: 45,
  /** 模式 A：1m 效率比下限（低于视为震荡结构，不参与；与「入场早」正交的防磨损守门） */
  ENTRY_MIN_ER: 0.35,
  /** 模式 B（5m 震荡/数据不足·震荡选向）：比模式 A 严一档的 score（缺 5m 背景背书），
   *  同样按「起点可达」定线——震荡突破选向的第一时间分数通常在 50-65 */
  NEUTRAL_MIN_SCORE: 55,
  /** 模式 B：更严的 ER 下限（震荡中选向，对结构干净度要求更高） */
  NEUTRAL_MIN_ER: 0.45,
  /** 是否允许 1m 方向与 5m 背景相反的逆势单（用户思路：短周期套利不做逆势 → false） */
  ALLOW_HTF_OPPOSED: false,
  /** 同一趋势周期最大开仓轮次（用户定版 2026-10-18：2 = 第一顺势单按时间顺序天然先做
   *  （胜率更高），走弱离场后「重新走强」（回确认 + 新收盘 K 线）允许 #R2 再入场——
   *  不强制只做第一波；追入保护对全部轮次生效。调 1 = 只做第一波（Task 66 曾用）） */
  MAX_ROUNDS_PER_CYCLE: 2,
  /** 同周期再入场最小间隔（上次平仓 → 下次评估开仓，防同一根 K 线内反复进出；
   *  仅 MAX_ROUNDS_PER_CYCLE ≥ 2 时有意义） */
  REENTRY_MIN_GAP_MS: 60_000,
  /** 入场追入保护（%）：确认瞬间短窗（SPIKE_WINDOW_MS）内价格已顺该方向运动 ≥ 该值 →
   *  拒绝入场——方向确实走强但已到脉冲末端，追入即接脉冲顶。0 = 关闭 */
  ENTRY_CHASE_PCT: 1.2,
  /** 确认新鲜窗（ms，Task 68 定版：仅约束首轮 R1）：首轮只做「周期确认时刻距 now
   *  ≤ 该值」的方向刚走强顺势单（首轮偏好高胜率的「刚走强」单，确认已走老不追）；
   *  R2 再入场的新鲜度由「重新走强」事件自身定义（回确认 + 新收盘 K 线），不受周期
   *  年龄约束——否则确认超 3 分钟后 R2 永远进不去。0 = 关闭 */
  ENTRY_FRESH_MS: 180_000,
  /** 冲高检测窗口（ms）：该窗口内标记价顺向运动幅度作为「正在冲高/下杀」判据 */
  SPIKE_WINDOW_MS: 90_000,
  /** 冲高幅度阈值（%）：窗口内顺向运动 ≥ 该值视为冲高（20x 下 0.4% = 8% 保证金收益；
   *  复盘定版：0.6 时浮盈卡在 0.3~0.6% 区间的单子全部被走弱离场割掉，够得着的落袋线） */
  SPIKE_MOVE_PCT: 0.4,
  /** 冲高套利最短持仓时间（ms）：防开仓瞬间样本噪声即触发 */
  SPIKE_MIN_HOLD_MS: 45_000,
  /** 走弱是否提前离场（true = END_PENDING 同周期即走，配合轮次再入场；false = 等 ENDED） */
  WEAKNESS_EXIT_EARLY: true,
  /** 价格样本保留时长（ms；observe 采样粒度 ≈ SCAN_MS=10s → 约 72 个样本/币） */
  SAMPLE_TTL_MS: 12 * 60_000,
};

export type ShortSwingParams = Partial<typeof SHORT_SWING>;

/** 合并参数（构造器覆盖 → 测试/未来配置入口可调；未指定项用默认） */
function withDefaults(p?: ShortSwingParams): typeof SHORT_SWING {
  return { ...SHORT_SWING, ...(p ?? {}) };
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

/** 短窗价格样本 */
interface PriceSample {
  t: number;
  p: number;
}

export class ShortSwingStrategy implements TrendStrategy {
  readonly id = 'short-swing-v1';
  readonly name = '短周期套利';
  readonly description =
    '异动选币不问方向；1m 确认即定多空，顺势入场（5m 同向=波段 / 5m 震荡=选向稍严；5m 反向不做）；' +
    '首轮只做方向刚走强的新鲜单、脉冲末端不追；冲高/下杀及时落袋；走弱先走、同周期走强可再入场（≤2 轮）';

  /** 可调参数（构造器覆盖；生产默认值） */
  readonly params: typeof SHORT_SWING;

  private states = new Map<string, SymbolState>();
  private samples = new Map<string, PriceSample[]>();
  /** 状态变化回调（AutoPaperTrader 注入：持久化到 TrendStrategyState） */
  private onStateChange: ((strategyId: string, symbol: string, json: string) => void) | null = null;

  constructor(params?: ShortSwingParams) {
    this.params = withDefaults(params);
  }

  bindPersistence(fn: (strategyId: string, symbol: string, json: string) => void): void {
    this.onStateChange = fn;
  }

  // ============ 行情采样（冲高检测的数据基础；全部为当时可用数据） ============

  observe(symbol: string, mark: number, now: number): void {
    if (!(mark > 0)) return;
    const arr = this.samples.get(symbol) ?? [];
    const last = arr[arr.length - 1];
    // 同一采样粒度内重复推送（<5s）覆盖末位，防 tick 重入导致样本堆积
    if (last && now - last.t < 5_000) {
      last.p = mark;
      last.t = now;
    } else {
      arr.push({ t: now, p: mark });
    }
    const cutoff = now - this.params.SAMPLE_TTL_MS;
    while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
    this.samples.set(symbol, arr);
  }

  /**
   * 窗口内顺向运动幅度（%）：LONG 看涨幅、SHORT 看跌幅；样本不足返回 0（不误判）。
   * 窗口 = 最新样本向前 SPIKE_WINDOW_MS：基准取目标时刻前最近的样本（若窗口起点前无样本
   * 则取最早样本）——冲高是连续过程，不因采样相位对不齐而丢窗误判。
   */
  private spikePct(symbol: string, side: 'LONG' | 'SHORT', _now: number): number {
    const arr = this.samples.get(symbol);
    if (!arr || arr.length < 2) return 0;
    const cur = arr[arr.length - 1]!;
    const target = cur.t - this.params.SPIKE_WINDOW_MS;
    let base = arr[0]!;
    for (const s of arr) {
      if (s.t <= target) {
        base = s; // 目标时刻之前：不断逼近目标时刻
      } else {
        if (base === arr[0] && base.t > target) base = s; // 窗口起点前无样本：取最早
        break;
      }
    }
    if (base.t >= cur.t) return 0;
    const movePct = (cur.p / base.p - 1) * 100;
    return side === 'LONG' ? movePct : -movePct;
  }

  // ============ 入场评估（① 选币已由池完成；②③④ 模式判定 + 门槛） ============

  evaluateEntry(signal: UnifiedTrendSignal, ctx: StrategyMarketCtx): StrategyEntryVerdict {
    const sym = signal.symbol;
    // ① 短周期方向确定：仅 1m 确认相位（候选/观察/结束中的趋势不开仓——方向未定）
    if (signal.phase !== 'CONFIRMED_UP' && signal.phase !== 'CONFIRMED_DOWN') {
      return { want: false, side: null, modeTag: '-', reason: `1m 趋势未确认（phase=${signal.phase}），短周期方向不确定` };
    }
    const side: 'LONG' | 'SHORT' = signal.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';

    // ⑤ 轮次约束：同周期走强再入场有上限（新周期自动从 1 开始；防同周期反复磨损）
    const st = this.states.get(sym);
    const sameCycle = st != null && st.cycleId === signal.trendCycleId;
    const nextRound = this.nextRound(sym, signal.trendCycleId ?? '');
    if (signal.trendCycleId && nextRound > this.params.MAX_ROUNDS_PER_CYCLE) {
      return {
        want: false, side: null, modeTag: '-',
        reason: `本趋势周期轮次已用尽（${st?.round}/${this.params.MAX_ROUNDS_PER_CYCLE}），防同周期反复磨损`,
      };
    }
    if (sameCycle && st?.lastExitAt != null && Date.now() - st.lastExitAt < this.params.REENTRY_MIN_GAP_MS) {
      return { want: false, side: null, modeTag: '-', reason: '同周期再入场间隔不足（刚离场，等待新证据）' };
    }
    // 同周期再入场要求出现「上次开仓之后的新已收盘 K 线」（走强的证据，不是旧信号的回声）
    if (sameCycle && st?.lastEntryBar != null && signal.lastBarTime != null && signal.lastBarTime <= st.lastEntryBar) {
      return { want: false, side: null, modeTag: '-', reason: '同周期再入场等待新收盘 K 线（无新证据）' };
    }

    // ⑨-c 确认新鲜窗（Task 68：仅约束首轮 R1）：首轮只做「方向刚走强」的第一时间顺势单
    //      （首轮偏好高胜率单，确认已走老再进 = 追已走完一段的行情，正是复盘指出的追涨/
    //      追空；trendStartedAt 缺失时防御性放行不挡单）。R2 再入场不受本窗约束——它的
    //      触发事件本身就是「重新走强」（回确认 + 新收盘 K 线，见 ⑤ 的新 K 线门槛），
    //      新鲜度由自身事件定义，不受周期年龄约束
    if (
      nextRound === 1 &&
      this.params.ENTRY_FRESH_MS > 0 &&
      signal.trendStartedAt != null &&
      ctx.now - signal.trendStartedAt > this.params.ENTRY_FRESH_MS
    ) {
      const ageMin = ((ctx.now - signal.trendStartedAt) / 60_000).toFixed(1);
      return {
        want: false, side: null, modeTag: 'STALE_CONFIRM',
        reason: `确认已走老（${ageMin} 分钟前确认，超出新鲜窗 ${Math.round(this.params.ENTRY_FRESH_MS / 60_000)} 分钟），首轮只做方向刚走强的第一时间顺势单`,
      };
    }

    // ②③ 5m 背景方向分级（15m 仅快照留档，不设门槛——主要做短周期）
    const dir = signal.direction;
    const h5 = signal.htf5m;
    const aligned = h5.valid && h5.dir === dir;
    const opposed = h5.valid && h5.dir !== 'flat' && h5.dir !== dir;
    if (opposed && !this.params.ALLOW_HTF_OPPOSED) {
      return {
        want: false, side: null, modeTag: 'HTF_OPPOSED',
        reason: `1m ${dir === 'up' ? '看多' : '看空'}与 5m 背景（${h5.dir}）相反，短周期套利不做逆势`,
      };
    }

    // ⑧-b 入场追入保护：确认瞬间短窗内已顺向冲高过多 = 脉冲末端，不追（方向走强的
    //      第一时间才顺势；冲过头的等它消化，消化后的新机会属于新周期/新确认）
    if (this.params.ENTRY_CHASE_PCT > 0) {
      const chase = this.spikePct(sym, side, ctx.now);
      if (chase >= this.params.ENTRY_CHASE_PCT) {
        return {
          want: false, side: null, modeTag: 'CHASE_GUARD',
          reason: `短窗已顺向冲高 ${chase.toFixed(2)}% ≥ ${this.params.ENTRY_CHASE_PCT}%（脉冲末端不追入，防接脉冲顶）`,
        };
      }
    }

    // 质量门槛：模式 A（同向）用常规线；模式 B（5m 震荡/数据不足，1m 先选向）用更严的线
    const score = signal.score;
    const er = signal.features.efficiencyRatio;
    if (aligned) {
      if (score < this.params.ENTRY_MIN_SCORE) {
        return { want: false, side: null, modeTag: 'TREND_ALIGNED', reason: `评分 ${score.toFixed(0)} < ${this.params.ENTRY_MIN_SCORE}（趋势起点门槛）` };
      }
      if (er < this.params.ENTRY_MIN_ER) {
        return { want: false, side: null, modeTag: 'TREND_ALIGNED', reason: `ER ${er.toFixed(2)} < ${this.params.ENTRY_MIN_ER}（趋势起点门槛）` };
      }
      return {
        want: true, side, modeTag: 'TREND_ALIGNED',
        reason: `1m ${dir === 'up' ? '看多' : '看空'}且 5m 同向（趋势内波段）score=${score.toFixed(0)} er=${er.toFixed(2)}${nextRound > 1 ? ` 轮次#R${nextRound}` : ''}`,
      };
    }
    // 模式 B：5m 震荡（flat）或 5m 数据不足（INVALID→视同震荡，不冒充同向支持）
    if (score < this.params.NEUTRAL_MIN_SCORE) {
      return { want: false, side: null, modeTag: 'RANGE_DIRECTION', reason: `5m 震荡中选向需更严证据：评分 ${score.toFixed(0)} < ${this.params.NEUTRAL_MIN_SCORE}` };
    }
    if (er < this.params.NEUTRAL_MIN_ER) {
      return { want: false, side: null, modeTag: 'RANGE_DIRECTION', reason: `5m 震荡中选向需更严证据：ER ${er.toFixed(2)} < ${this.params.NEUTRAL_MIN_ER}` };
    }
    return {
      want: true, side, modeTag: 'RANGE_DIRECTION',
      reason: `5m 背景震荡，1m 先行选向（${dir === 'up' ? '看多' : '看空'}）score=${score.toFixed(0)} er=${er.toFixed(2)}${nextRound > 1 ? ` 轮次#R${nextRound}` : ''}`,
    };
  }

  // ============ 离场评估（⑥ 冲高套利 + ⑤ 走弱先走；ENDED/反向/强平由基础设施处理） ============

  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: { entryPrice: number; qty: number; margin: number; side: 'LONG' | 'SHORT'; openedAt: number };
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    const { meta, pos, mark, signal, now } = input;

    // ⑥ 冲高套利：浮盈 + 短窗顺向快速运动 → 及时落袋（对冲冲高回落/下杀拉回）
    const holdMs = now - pos.openedAt;
    if (holdMs >= this.params.SPIKE_MIN_HOLD_MS && pos.margin > 0) {
      const sign = pos.side === 'LONG' ? 1 : -1;
      const profitPct = ((mark - pos.entryPrice) * pos.qty * sign / pos.margin) * 100;
      if (profitPct > 0) {
        const spike = this.spikePct(meta.symbol, pos.side, now);
        if (spike >= this.params.SPIKE_MOVE_PCT) {
          return {
            exit: true,
            reason: 'SPIKE_TAKE',
            detail: `冲高套利：${pos.side === 'LONG' ? '短窗拉升' : '短窗下杀'} +${spike.toFixed(2)}%（≥${this.params.SPIKE_MOVE_PCT}%），浮盈 ${profitPct.toFixed(1)}% 及时落袋`,
          };
        }
      }
    }

    // ⑤ 走弱先走：本周期出现结束迹象即离场（走强后按轮次再入场；
    //    异周期 END_PENDING 与本持仓无关，绝不误平）
    if (this.params.WEAKNESS_EXIT_EARLY && signal && signal.phase === 'END_PENDING') {
      if (signal.trendCycleId && signal.trendCycleId === meta.trendCycleId) {
        return {
          exit: true,
          reason: 'WEAKNESS_EARLY',
          detail: `短周期走弱先走（END_PENDING 证据 ${signal.endEvidenceBars} 根），走强后可再入场`,
        };
      }
    }

    return { exit: false, reason: null, detail: '' };
  }

  // ============ 轮次状态 ============

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
    this.flush(symbol, now);
  }

  onClose(symbol: string, cycleId: string, reason: string, now: number): void {
    const prev = this.states.get(symbol);
    if (prev && prev.cycleId === cycleId) {
      this.states.set(symbol, { ...prev, lastExitAt: now, lastExitReason: reason });
      this.flush(symbol, now);
    }
    // 周期不匹配（旧周期残响）：不动状态
    this.samples.delete(symbol); // 持仓结束，冲高样本清空（下轮持仓重建）
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

  private flush(symbol: string, _now: number): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(this.id, symbol, JSON.stringify(this.states.get(symbol) ?? {}));
    } catch {
      // 持久化失败不影响决策（状态仍在内存；重启后轮次可能回退一档——可接受）
    }
  }
}
