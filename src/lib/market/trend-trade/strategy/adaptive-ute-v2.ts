// ---------- 自适应 UTE 决策层 v2（adaptive-ute-v2） ----------
//
// 目标：不改 UTE 的趋势方向与五因子评分公式，在决策层区分两种机会：
// 1) TREND_CONTINUATION：原始 UTE 方向、量能/方向一致性足够，且 5m/15m 没有反向冲突；
// 2) REVERSAL_FADE：即使 UTE score 很高，只在「成熟信号 + 至少两项反转证据」时反向交易。
// 低相对成交量不按某个时钟时段硬过滤，而是作为量能衰减证据；过低相对量能仍然不开仓。
// UTE 原始五因子快照来自 UnifiedTrendSignal.uteEvidence，波动率和 HTF 来自现有决策信封。
// 所有阈值是明日模拟测试用的起始参数，尚未经过足量回放，不代表已验证的盈利策略。

import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendTradeMetaRow } from '../repo';
import type {
  StrategyEntryVerdict,
  StrategyExitVerdict,
  StrategyMarketCtx,
  StrategyPositionCtx,
  TrendStrategy,
} from './types';

export const ADAPTIVE_UTE_V2 = {
  /** UTE 顺势模式最低分：不把 70 当作胜率线，高分也可能处于趋势末端 */
  CONTINUATION_MIN_SCORE: 55,
  /** UTE 原始方向一致性最低值 */
  CONTINUATION_MIN_CONSISTENCY: 0.55,
  /** 方向效率 ER 下限 */
  CONTINUATION_MIN_ER: 0.30,
  /** 顺势入场最低相对量能（最近 3 根均量 / 前 10 根均量） */
  CONTINUATION_MIN_VOLUME_RATIO: 0.65,
  /** 相对量能低于该值时，顺势与反转模式都不开仓 */
  HARD_MIN_VOLUME_RATIO: 0.35,

  /** 反转模式最低 UTE 证据分；分数只说明证据强弱，不直接代表胜率 */
  REVERSAL_MIN_SCORE: 60,
  /** 反转模式至少达到的 UTE 连续观察成熟度（极强证据有独立放行条件） */
  REVERSAL_MIN_CONFIRM_COUNT: 4,
  REVERSAL_MIN_STRONG_SCORE: 75,
  REVERSAL_LATE_EXHAUSTION_MIN_SCORE: 70,
  /** 5m HTF 在 UTE 同方向的累计位移上限，达到后需与至少一项衰竭迹象共现。 */
  REVERSAL_HTF5M_STRETCH_PCT: 2.5,
  REVERSAL_MIN_STRONG_STRENGTH: 0.75,
  /** 至少需要两项反转线索，其中至少一项必须是结构 / 影线 / HTF 主证据 */
  REVERSAL_MIN_CUES: 2,
  REVERSAL_REJECTION_WICK_MIN: 0.42,
  /** 相对量能低于该值，作为可能的末端量能衰减线索，而不是按时钟禁交易 */
  REVERSAL_DRY_VOLUME_RATIO: 0.75,
  /** 极端波动 / 区间突然扩张作为次级反转线索 */
  REVERSAL_EXTREME_VOL_PERCENTILE: 0.85,
  REVERSAL_RANGE_EXPANSION: 1.8,

  /** 同一 UTE 周期只做一笔，避免震荡中多次试错 */
  MAX_ROUNDS_PER_CYCLE: 1,
  REENTRY_MIN_GAP_MS: 180_000,

  /** UTE 顺势仓退出阈值：价格逆行百分比 / 保证金盈利回撤百分比 */
  CONTINUATION_STOP_LOSS_PCT: 1.15,
  CONTINUATION_TRAIL_ARM_PCT: 26,
  CONTINUATION_TRAIL_GIVEBACK_PCT: 14,
  /** 反转试探仓采用更紧的价格止损和更早的利润保护 */
  REVERSAL_STOP_LOSS_PCT: 0.85,
  REVERSAL_TRAIL_ARM_PCT: 18,
  REVERSAL_TRAIL_GIVEBACK_PCT: 9,
};

export type AdaptiveUteV2Params = Partial<typeof ADAPTIVE_UTE_V2>;

interface SymbolState {
  cycleId: string | null;
  round: number;
  lastEntryBar: number | null;
  lastExitAt: number | null;
  lastExitReason: string | null;
}

type Side = 'LONG' | 'SHORT';
function sideOf(dir: 'up' | 'down' | 'flat'): Side | null {
  return dir === 'up' ? 'LONG' : dir === 'down' ? 'SHORT' : null;
}

function readMode(meta: TrendTradeMetaRow): string | null {
  try {
    const snapshot = JSON.parse(meta.featuresAtOpen || '{}') as { modeTag?: unknown };
    return typeof snapshot.modeTag === 'string' ? snapshot.modeTag : null;
  } catch {
    return null;
  }
}

function isFadePosition(meta: TrendTradeMetaRow): boolean {
  return readMode(meta)?.startsWith('UTE_REVERSAL_FADE') ?? false;
}

function aligned(dir: 'up' | 'down' | 'flat', htfDir: 'up' | 'down' | 'flat'): boolean {
  return dir !== 'flat' && htfDir === dir;
}

export class AdaptiveUteV2Strategy implements TrendStrategy {
  readonly id = 'adaptive-ute-v2';
  readonly name = '自适应 UTE 趋势/反转';
  readonly description =
    '不改 UTE 趋势引擎；联合原始五因子、确认成熟度、量能、假突破、影线、波动及 5m/15m 背景，择机顺势或在多项证据确认时做反转。';

  readonly params: typeof ADAPTIVE_UTE_V2;

  private states = new Map<string, SymbolState>();
  private onStateChange: ((strategyId: string, symbol: string, json: string) => void) | null = null;

  constructor(params?: AdaptiveUteV2Params) {
    this.params = { ...ADAPTIVE_UTE_V2, ...(params ?? {}) };
  }

  bindPersistence(fn: (strategyId: string, symbol: string, json: string) => void): void {
    this.onStateChange = fn;
  }

  observe(_symbol: string, _mark: number, _now: number): void {
    // 只用 UTE 和现有已收盘 K 线特征，不自行重算价格方向。
  }

  evaluateEntry(signal: UnifiedTrendSignal, ctx: StrategyMarketCtx): StrategyEntryVerdict {
    const reject = (reason: string): StrategyEntryVerdict => ({
      want: false, side: null, modeTag: '-', reason,
    });

    if (signal.phase !== 'CONFIRMED_UP' && signal.phase !== 'CONFIRMED_DOWN') {
      return reject(`UTE 未确认（phase=${signal.phase}），不交易`);
    }
    if (!signal.dataFresh) return reject(`行情/ K 线数据不新鲜：${signal.dataUnavailableReason ?? 'unknown'}`);
    const dir = signal.direction;
    if (dir !== 'up' && dir !== 'down') return reject('UTE 已确认相位但方向无效，拒绝入场');
    const uteSide = sideOf(dir);
    const raw = signal.uteEvidence;
    if (!uteSide || !raw) return reject('缺少有效 UTE 原始决策因子，拒绝用不完整快照入场');

    const state = this.states.get(signal.symbol);
    const sameCycle = !!state && state.cycleId === signal.trendCycleId;
    const round = this.nextRound(signal.symbol, signal.trendCycleId ?? '');
    if (signal.trendCycleId && round > this.params.MAX_ROUNDS_PER_CYCLE) {
      return reject(`该 UTE 周期已交易 ${state?.round ?? 0} 次（上限 ${this.params.MAX_ROUNDS_PER_CYCLE}），不重复试错`);
    }
    if (sameCycle && state?.lastExitAt != null && ctx.now - state.lastExitAt < this.params.REENTRY_MIN_GAP_MS) {
      return reject('同一 UTE 周期刚平仓，仍在策略冷却中');
    }
    if (sameCycle && state?.lastEntryBar != null && signal.lastBarTime != null && signal.lastBarTime <= state.lastEntryBar) {
      return reject('同一 UTE 周期没有新的已收盘 K 线证据');
    }

    const volumeRatio = raw.volumeRatio;
    if (!Number.isFinite(volumeRatio) || volumeRatio < this.params.HARD_MIN_VOLUME_RATIO) {
      return reject(
        `相对量能过低（UTE recent3/baseline10=${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : 'invalid'} < ${this.params.HARD_MIN_VOLUME_RATIO}），不在薄量环境开仓`,
      );
    }

    const er = signal.features.efficiencyRatio;
    const consistency = raw.directionalConsistency;
    const h5Opposed = signal.htf5m.valid && signal.htf5m.dir !== 'flat' && !aligned(dir, signal.htf5m.dir);
    const h15Opposed = signal.htf15m.valid && signal.htf15m.dir !== 'flat' && !aligned(dir, signal.htf15m.dir);
    // 反转线索不是简单地「UTE 分数高就反做」：
    // 高分代表 UTE 五因子证据强，若没有趋势成熟度和反转结构，不做逆势单。
    const rejectionWick =
      dir === 'down'
        ? signal.features.lowerWickPct >= this.params.REVERSAL_REJECTION_WICK_MIN
        : signal.features.upperWickPct >= this.params.REVERSAL_REJECTION_WICK_MIN;
    const counterBreakout =
      (raw.breakout !== 'none' && raw.breakout !== dir) ||
      (signal.features.breakout !== 'none' && signal.features.breakout !== dir);
    const failedBreakout = signal.features.falseBreakout;
    const htfOpposed = h5Opposed || h15Opposed;
    const dryVolume = volumeRatio < this.params.REVERSAL_DRY_VOLUME_RATIO;
    const erCollapse = er < this.params.CONTINUATION_MIN_ER;
    const rangeClimax =
      raw.rangeExpansion >= this.params.REVERSAL_RANGE_EXPANSION ||
      signal.features.volRegime === 'EXTREME' ||
      signal.features.volPercentile >= this.params.REVERSAL_EXTREME_VOL_PERCENTILE;
    const mature =
      signal.confirmCount >= this.params.REVERSAL_MIN_CONFIRM_COUNT ||
      (signal.score >= this.params.REVERSAL_MIN_STRONG_SCORE &&
        signal.strength >= this.params.REVERSAL_MIN_STRONG_STRENGTH &&
        consistency >= 0.75);
    // 用户指出的典型反向盈利来源：UTE 高分顺着加速段入场，但临近末端时量能/效率衰减，
    // 随后价格反弹/回撤。它不是「高分就反做」：还要求成熟信号与极端扩张共现衰减证据。
    const lateMoveExhaustion =
      mature &&
      signal.score >= this.params.REVERSAL_LATE_EXHAUSTION_MIN_SCORE &&
      rangeClimax &&
      (dryVolume || erCollapse);

    // Task 83 以来新增的「5m 过度延伸」证据：htf5m.returnPct 是基于 5m K 线窗口的累计位移，
    // 若已沿 UTE 方向走出较大幅度，成熟的高分确认更可能发生在延伸后段；但不能只因走得远就反做，
    // 必须至少伴随一项独立衰竭迹象（影线/假突破/量能衰减/ER 走低/波动扩张/15m 冲突）。
    const htf5mStretched =
      signal.htf5m.valid &&
      (dir === 'down'
        ? signal.htf5m.returnPct <= -this.params.REVERSAL_HTF5M_STRETCH_PCT
        : signal.htf5m.returnPct >= this.params.REVERSAL_HTF5M_STRETCH_PCT);
    const htfStretchExhaustion =
      mature &&
      signal.score >= this.params.REVERSAL_LATE_EXHAUSTION_MIN_SCORE &&
      htf5mStretched &&
      (rejectionWick || failedBreakout || dryVolume || erCollapse || rangeClimax || h15Opposed);

    const primaryCueCount = [
      rejectionWick, counterBreakout, failedBreakout, htfOpposed,
      lateMoveExhaustion, htfStretchExhaustion,
    ].filter(Boolean).length;
    const cueCount = [
      rejectionWick,
      counterBreakout,
      failedBreakout,
      htfOpposed, // 5m/15m 冲突属于同一类证据，不因两个周期同时冲突重复计数
      dryVolume,
      erCollapse,
      rangeClimax,
      htf5mStretched,
    ].filter(Boolean).length;

    const cueNames = [
      rejectionWick ? '反转影线' : null,
      counterBreakout ? '反向突破' : null,
      failedBreakout ? '假突破' : null,
      h5Opposed ? '5m反向' : null,
      h15Opposed ? '15m反向' : null,
      dryVolume ? '量能衰减' : null,
      erCollapse ? 'ER走低' : null,
      rangeClimax ? '波动扩张' : null,
      htf5mStretched ? `5m同向延伸 ${signal.htf5m.returnPct.toFixed(2)}%` : null,
      lateMoveExhaustion ? '成熟高分末端扩张衰减' : null,
      htfStretchExhaustion ? '成熟高分+5m过度延伸+衰竭' : null,
    ].filter((x): x is string => x !== null);

    const canFade =
      signal.score >= this.params.REVERSAL_MIN_SCORE &&
      mature &&
      primaryCueCount >= 1 &&
      cueCount >= this.params.REVERSAL_MIN_CUES;

    if (canFade) {
      const side: Side = uteSide === 'LONG' ? 'SHORT' : 'LONG';
      return {
        want: true,
        side,
        modeTag: side === 'LONG' ? 'UTE_REVERSAL_FADE_LONG' : 'UTE_REVERSAL_FADE_SHORT',
        riskMultiplier: 0.65,
        reason:
          `反转模式：UTE仍为${uteSide === 'LONG' ? '上涨' : '下跌'}方向但已出现成熟反转证据，` +
          `选择${side === 'LONG' ? '反向做多' : '反向做空'}；score=${signal.score} confirm=${signal.confirmCount} ` +
          `consistency=${consistency.toFixed(2)} return=${raw.returnPct.toFixed(2)}% ` +
          `volRatio=${volumeRatio.toFixed(2)} ER=${er.toFixed(2)} cues=[${cueNames.join(',')}]`,
      };
    }

    // 顺势只在 UTE 因子与结构没有明显相悖时放行。HTF 冲突 / 假突破不直接硬反做，
    // 除非上面的反转模式已得到至少两类独立线索，否则等待。
    const directionalReturn = dir === 'up' ? raw.returnPct > 0 : raw.returnPct < 0;
    const pickEvidence =
      raw.breakout === dir ||
      signal.features.breakout === dir ||
      (er >= this.params.CONTINUATION_MIN_ER && consistency >= this.params.CONTINUATION_MIN_CONSISTENCY);
    const htfConflict = h5Opposed || h15Opposed;
    const continuation =
      signal.score >= this.params.CONTINUATION_MIN_SCORE &&
      consistency >= this.params.CONTINUATION_MIN_CONSISTENCY &&
      er >= this.params.CONTINUATION_MIN_ER &&
      volumeRatio >= this.params.CONTINUATION_MIN_VOLUME_RATIO &&
      directionalReturn &&
      pickEvidence &&
      !failedBreakout &&
      !counterBreakout &&
      !htfConflict;

    if (!continuation) {
      return reject(
        `等待更清晰的趋势/反转机会：score=${signal.score} consistency=${consistency.toFixed(2)} ` +
        `ER=${er.toFixed(2)} volRatio=${volumeRatio.toFixed(2)} breakout=${raw.breakout} ` +
        `rangeExpansion=${raw.rangeExpansion.toFixed(2)} HTF5=${signal.htf5m.valid ? signal.htf5m.dir : 'invalid'} ` +
        `HTF15=${signal.htf15m.valid ? signal.htf15m.dir : 'invalid'} reversalCues=[${cueNames.join(',')}]`,
      );
    }

    const htfDesc = `5m=${signal.htf5m.valid ? signal.htf5m.dir : 'invalid'},15m=${signal.htf15m.valid ? signal.htf15m.dir : 'invalid'}`;
    return {
      want: true,
      side: uteSide,
      modeTag: 'UTE_TREND_CONTINUATION',
      riskMultiplier: 1,
      reason:
        `UTE顺势：score=${signal.score} return=${raw.returnPct.toFixed(2)}% consistency=${consistency.toFixed(2)} ` +
        `volumeRatio=${volumeRatio.toFixed(2)} ER=${er.toFixed(2)} rangeExpansion=${raw.rangeExpansion.toFixed(2)} ` +
        `confirm=${signal.confirmCount} HTF[${htfDesc}]；方向与结构一致`,
    };
  }

  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: StrategyPositionCtx;
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    const { meta, pos, mark } = input;
    if (!(pos.entryPrice > 0) || !(mark > 0)) return { exit: false, reason: null, detail: '' };

    const fade = isFadePosition(meta);
    const stopPct = fade ? this.params.REVERSAL_STOP_LOSS_PCT : this.params.CONTINUATION_STOP_LOSS_PCT;
    const trailArmPct = fade ? this.params.REVERSAL_TRAIL_ARM_PCT : this.params.CONTINUATION_TRAIL_ARM_PCT;
    const trailGivebackPct = fade ? this.params.REVERSAL_TRAIL_GIVEBACK_PCT : this.params.CONTINUATION_TRAIL_GIVEBACK_PCT;
    const sign = pos.side === 'LONG' ? 1 : -1;
    const adversePct = ((pos.entryPrice - mark) / pos.entryPrice) * 100 * sign;

    if (stopPct > 0 && adversePct >= stopPct) {
      return {
        exit: true,
        reason: 'STOP_LOSS',
        detail:
          `${fade ? 'UTE反转试探' : 'UTE顺势'}硬止损：策略侧价格逆行 ${adversePct.toFixed(2)}% ≥ ${stopPct}%`,
      };
    }

    if (trailArmPct > 0 && trailGivebackPct > 0 && pos.margin > 0) {
      const livePnlPct = ((mark - pos.entryPrice) * pos.qty * sign / pos.margin) * 100;
      const peak = Math.max(meta.mfe ?? 0, livePnlPct);
      const giveback = peak - livePnlPct;
      if (peak >= trailArmPct && giveback >= trailGivebackPct) {
        return {
          exit: true,
          reason: 'TRAIL_TAKE',
          detail:
            `${fade ? 'UTE反转试探' : 'UTE顺势'}移动止盈：峰值浮盈 ${peak.toFixed(1)}% ≥ ${trailArmPct}% 后回撤 ${giveback.toFixed(1)}% ≥ ${trailGivebackPct}%`,
        };
      }
    }
    return { exit: false, reason: null, detail: '' };
  }

  /** Hold a fade position while the original UTE cycle is still the only confirmed direction. */
  shouldCloseOnConfirmedReverse(meta: TrendTradeMetaRow, signal: UnifiedTrendSignal): boolean {
    if (isFadePosition(meta) && (!signal.trendCycleId || signal.trendCycleId === meta.trendCycleId)) {
      return false;
    }
    return meta.side === 'LONG' ? signal.direction !== 'up' : signal.direction !== 'down';
  }

  nextRound(symbol: string, cycleId: string): number {
    const state = this.states.get(symbol);
    if (!state || !cycleId) return 1;
    return state.cycleId === cycleId ? state.round + 1 : 1;
  }

  onOpen(symbol: string, cycleId: string, barTime: number | null, _now: number): void {
    const prev = this.states.get(symbol);
    const state: SymbolState =
      prev && prev.cycleId === cycleId
        ? { ...prev, round: prev.round + 1 }
        : { cycleId, round: 1, lastEntryBar: null, lastExitAt: null, lastExitReason: null };
    state.lastEntryBar = barTime;
    this.states.set(symbol, state);
    this.flush(symbol);
  }

  onClose(symbol: string, cycleId: string, reason: string, now: number, _exitPrice?: number): void {
    const prev = this.states.get(symbol);
    if (prev && prev.cycleId === cycleId) {
      this.states.set(symbol, { ...prev, lastExitAt: now, lastExitReason: reason });
      this.flush(symbol);
    }
  }

  exportState(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [symbol, state] of this.states) out[symbol] = state;
    return out;
  }

  importState(raw: unknown): void {
    this.states.clear();
    if (!raw || typeof raw !== 'object') return;
    for (const [symbol, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const state = value as Partial<SymbolState>;
      if (typeof state.cycleId !== 'string' || typeof state.round !== 'number') continue;
      this.states.set(symbol, {
        cycleId: state.cycleId,
        round: state.round,
        lastEntryBar: typeof state.lastEntryBar === 'number' ? state.lastEntryBar : null,
        lastExitAt: typeof state.lastExitAt === 'number' ? state.lastExitAt : null,
        lastExitReason: typeof state.lastExitReason === 'string' ? state.lastExitReason : null,
      });
    }
  }

  private flush(symbol: string): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(this.id, symbol, JSON.stringify(this.states.get(symbol) ?? {}));
    } catch {
      // Persistence failure must never block simulated trade management.
    }
  }
}
