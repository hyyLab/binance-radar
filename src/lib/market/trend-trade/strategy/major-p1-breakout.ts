// ---------- 策略：MAJOR P1 重大异动突破 v1 ----------
// 目标：不依赖 TrendWatchService 候选池，不等待 UTE 确认/下一根 1m 收盘 K 线；
// 新 MAJOR P1 事件到达后，区分平台突破、趋势加速和已确认假突破，再通过共享 PaperEngine 模拟开仓。
// 所有百分比均为标的价格变动百分比，不是保证金收益率。参数为初始工程值，未经历史回放校准。

import type { EnhancedEventDTO } from '../../enhanced/types';
import type { TrendCandle } from '../../trend-watch/types';
import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendExitReason } from '../config';
import type { TrendTradeMetaRow } from '../repo';
import type {
  StrategyEventEntryVerdict,
  StrategyExitVerdict,
  StrategyMarketCtx,
  StrategyPositionCtx,
  TrendStrategy,
} from './types';

export const MAJOR_P1_BREAKOUT = {
  /** 取 MAJOR P1 发生前的 1m 收盘 K 线识别局部平台 */
  MP1_PLATFORM_LOOKBACK_BARS: 20,
  /** 回看区间振幅上限；价格在此范围内横盘才归为平台型 */
  MP1_PLATFORM_MAX_RANGE_PCT: 5.5,
  /** 平台回看窗口首尾收盘价净位移上限，避免把已有单边趋势误判为平台 */
  MP1_PLATFORM_MAX_DRIFT_PCT: 3.5,
  /** 突破平台边界至少超出该比例才视为有效突破 */
  MP1_PLATFORM_BREAKOUT_CLEARANCE_PCT: 0.35,
  /** 加速型异动离事件触发价已经走出太远则不追 */
  MP1_MAX_CHASE_FROM_EVENT_PCT: 6.5,
  /** 紧急硬止损：入场后逆向价格变动达到该比例即退出 */
  MP1_HARD_STOP_PCT: 2.5,
  /** 平台突破回到边界内达到该比例，判定原突破逻辑失效 */
  MP1_FALSE_BREAK_RETURN_PCT: 1.0,
  /** 假突破确认后，价格进一步反向运动达到该比例才允许反向入场 */
  MP1_FALSE_BREAK_REVERSAL_CONFIRM_PCT: 1.5,
  /** 顺向浮盈达到该比例后，启动保本保护 */
  MP1_BREAKEVEN_ARM_PCT: 2.0,
  /** 保本保护退出线：入场价顺向偏移该比例，覆盖部分交易成本的目标值 */
  MP1_BREAKEVEN_OFFSET_PCT: 0.3,
  /** 浮盈峰值达到该比例后，启用移动止盈 */
  MP1_TRAIL_START_PCT: 3.0,
  /** 从最大有利价格回撤达到该幅度，触发移动止盈 */
  MP1_TRAIL_DISTANCE_PCT: 1.8,
  /** 价格方向收益达到该比例时全部止盈 */
  MP1_TAKE_PROFIT_PCT: 6.0,
  /** 同一 MAJOR P1 周期再次交易，需要从上一笔入场价继续顺向扩展的幅度 */
  MP1_REENTRY_EXTENSION_PCT: 1.5,
  /** 加速型异动使用较小保证金预算，避免追入成熟脉冲时承担完整仓位风险 */
  MP1_ACCELERATION_MARGIN_SCALE: 0.5,
  /** 假突破确认后的反向交易使用较小保证金预算 */
  MP1_FALSE_BREAK_MARGIN_SCALE: 0.75,
} as const;

export type MajorP1BreakoutParams = Partial<typeof MAJOR_P1_BREAKOUT>;

type Side = 'LONG' | 'SHORT';
type BreakoutMode = 'PLATFORM_BREAKOUT' | 'TREND_ACCELERATION' | 'FALSE_BREAK_REVERSAL';

interface BreakoutProfile {
  eventId: string;
  p1At: number;
  eventDirection: 'UP' | 'DOWN';
  modeTag: BreakoutMode | string;
  platform: boolean;
  rangeHigh: number;
  rangeLow: number;
  rangePct: number;
  driftPct: number;
  eventPrice: number;
  marginScale: number;
}

interface SymbolState {
  cycleId: string;
  round: number;
  lastEntryAt: number;
  lastEntryPrice: number;
  lastEntrySide: Side;
  lastExitAt: number | null;
  lastExitReason: string | null;
  peakFavorablePct: number;
  profile: BreakoutProfile;
}

interface PriceSample {
  t: number;
  p: number;
}

const ONE_MINUTE_MS = 60_000;
const FIRST_ENTRY_MAX_AGE_MS = 45_000;
const MAX_MARK_AGE_MS = 10_000;
const MIN_QV24H_USDT = 1_000_000;
const REENTRY_MIN_GAP_MS = 5_000;
const FALSE_BREAK_MIN_HOLD_MS = 5_000;
const SAMPLE_TTL_MS = 15 * 60_000;

export function majorP1CycleId(event: EnhancedEventDTO): string {
  const p1At = typeof event.p1At === 'number' && event.p1At > 0 ? event.p1At : event.firstAt;
  return `MAJORP1:${event.id}:P1:${p1At}`;
}

function withDefaults(p?: MajorP1BreakoutParams): typeof MAJOR_P1_BREAKOUT {
  return { ...MAJOR_P1_BREAKOUT, ...(p ?? {}) };
}

function sideOf(dir: 'UP' | 'DOWN'): Side {
  return dir === 'UP' ? 'LONG' : 'SHORT';
}

function opposite(side: Side): Side {
  return side === 'LONG' ? 'SHORT' : 'LONG';
}

function dirOf(side: Side): 'up' | 'down' {
  return side === 'LONG' ? 'up' : 'down';
}

function signedPriceMovePct(from: number, to: number, side: Side): number {
  if (!(from > 0) || !(to > 0)) return 0;
  return side === 'LONG' ? (to / from - 1) * 100 : (from / to - 1) * 100;
}

function closedBefore(candles: TrendCandle[], cutoff: number): TrendCandle[] {
  return candles
    .filter((c) =>
      Number.isFinite(c.t) && c.t > 0 &&
      Number.isFinite(c.o) && c.o > 0 &&
      Number.isFinite(c.h) && c.h > 0 &&
      Number.isFinite(c.l) && c.l > 0 &&
      Number.isFinite(c.c) && c.c > 0 &&
      Number.isFinite(c.qv) && c.qv >= 0 &&
      c.t + ONE_MINUTE_MS <= cutoff,
    )
    .sort((a, b) => a.t - b.t);
}

function noEntry(reason: string): StrategyEventEntryVerdict {
  return {
    want: false, side: null, modeTag: '-', reason, cycleId: null, marginScale: 1, signal: null,
  };
}

function parseProfile(signalAtOpen: string): BreakoutProfile | null {
  try {
    const parsed = JSON.parse(signalAtOpen) as { breakoutTrade?: BreakoutProfile };
    const p = parsed?.breakoutTrade;
    if (
      !p || typeof p.eventId !== 'string' || typeof p.p1At !== 'number' ||
      typeof p.rangeHigh !== 'number' || typeof p.rangeLow !== 'number' ||
      typeof p.platform !== 'boolean' || typeof p.modeTag !== 'string'
    ) return null;
    return p;
  } catch {
    return null;
  }
}

export class MajorP1BreakoutStrategy implements TrendStrategy {
  readonly id = 'major-p1-breakout-v1';
  readonly name = 'MAJOR P1 突破交易';
  readonly description =
    '独立监听 MAJOR P1 异动；平台突破/趋势加速分型，事件触发即模拟入场，结构失效止损、保本与移动止盈，允许新结构再次入场';
  readonly eventDriven = true as const;
  readonly params: typeof MAJOR_P1_BREAKOUT;

  private states = new Map<string, SymbolState>();
  private samples = new Map<string, PriceSample[]>();
  private prepared = new Map<string, { cycleId: string; side: Side; profile: BreakoutProfile; price: number }>();
  private onStateChange: ((strategyId: string, symbol: string, json: string) => void) | null = null;

  constructor(params?: MajorP1BreakoutParams) {
    this.params = withDefaults(params);
  }

  bindPersistence(fn: (strategyId: string, symbol: string, json: string) => void): void {
    this.onStateChange = fn;
  }

  observe(symbol: string, mark: number, now: number): void {
    if (!(mark > 0)) return;
    const arr = this.samples.get(symbol) ?? [];
    const last = arr[arr.length - 1];
    if (last && now - last.t < 1_000) {
      last.t = now;
      last.p = mark;
    } else {
      arr.push({ t: now, p: mark });
    }
    const cutoff = now - SAMPLE_TTL_MS;
    while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
    this.samples.set(symbol, arr);

    // 维护内存中的价格峰值；持仓的数据库 MFE 仍是重启后的兜底来源。
    const st = this.states.get(symbol);
    if (st && st.lastEntryPrice > 0) {
      st.peakFavorablePct = Math.max(st.peakFavorablePct, signedPriceMovePct(st.lastEntryPrice, mark, st.lastEntrySide));
    }
  }

  /** 趋势池入口刻意关闭：本策略的唯一新开仓入口是 evaluateEventEntry。 */
  evaluateEntry(): StrategyEventEntryVerdict {
    return noEntry('该算法只响应新鲜 MAJOR P1 事件，不消费趋势池信号');
  }

  evaluateEventEntry(
    event: EnhancedEventDTO,
    candles: TrendCandle[],
    ctx: StrategyMarketCtx,
  ): StrategyEventEntryVerdict {
    const p1At = typeof event.p1At === 'number' && event.p1At > 0 ? event.p1At : event.firstAt;
    const cycleId = majorP1CycleId(event);
    if (event.state !== 'ACTIVE' || event.level !== 'MAJOR' || event.priority !== 'P1') {
      return noEntry('当前事件不是 ACTIVE + MAJOR + P1');
    }
    if (!(ctx.mark > 0) || (ctx.marketUpdatedAt != null && ctx.now - ctx.marketUpdatedAt > MAX_MARK_AGE_MS)) {
      return noEntry('标记价缺失或行情已过期');
    }
    if (ctx.quoteVolume24h != null && ctx.quoteVolume24h < MIN_QV24H_USDT) {
      return noEntry(`24h 成交额低于 ${MIN_QV24H_USDT} USDT`);
    }

    const st = this.states.get(event.symbol);
    const sameCycle = st?.cycleId === cycleId;
    const nextRound = sameCycle && st ? st.round + 1 : 1;
    if (nextRound === 1 && ctx.now - p1At > FIRST_ENTRY_MAX_AGE_MS) {
      return noEntry('首次 MAJOR P1 触发已过时，拒绝追入陈旧事件');
    }

    const prior = closedBefore(candles, p1At);
    const lookback = prior.slice(-this.params.MP1_PLATFORM_LOOKBACK_BARS);
    let rangeHigh = 0;
    let rangeLow = 0;
    let rangePct = 0;
    let driftPct = 0;
    if (lookback.length >= Math.min(12, this.params.MP1_PLATFORM_LOOKBACK_BARS)) {
      rangeHigh = Math.max(...lookback.map((c) => c.h));
      rangeLow = Math.min(...lookback.map((c) => c.l));
      const mid = (rangeHigh + rangeLow) / 2;
      rangePct = mid > 0 ? ((rangeHigh - rangeLow) / mid) * 100 : 0;
      const first = lookback[0].c;
      const last = lookback[lookback.length - 1].c;
      driftPct = first > 0 ? ((last / first) - 1) * 100 : 0;
    }
    const isPlatform = lookback.length >= Math.min(12, this.params.MP1_PLATFORM_LOOKBACK_BARS) &&
      rangePct <= this.params.MP1_PLATFORM_MAX_RANGE_PCT &&
      Math.abs(driftPct) <= this.params.MP1_PLATFORM_MAX_DRIFT_PCT;

    let side: Side;
    let modeTag: BreakoutMode | string;
    let marginScale = 1;
    let profile: BreakoutProfile;

    // 同一个 P1 周期已交易过：只有重新出现独立的顺向价格扩展，或假突破确认后的反向延伸，
    // 才允许下一轮。不会把同一条 ACTIVE 事件的每次更新时间当作新入场信号。
    if (sameCycle && st) {
      if (st.lastExitAt == null) return noEntry('该 P1 周期已有一轮入场记录，等待上一笔完成离场');
      if (ctx.now - st.lastExitAt < REENTRY_MIN_GAP_MS) return noEntry('刚刚离场，等待最短重新评估间隔');
      profile = { ...st.profile };
      if (st.lastExitReason === 'BREAKOUT_FALSE_EXIT' && st.profile.platform) {
        side = opposite(st.lastEntrySide);
        const reversalConfirmed = side === 'SHORT'
          ? ctx.mark <= st.profile.rangeHigh * (1 - this.params.MP1_FALSE_BREAK_REVERSAL_CONFIRM_PCT / 100)
          : ctx.mark >= st.profile.rangeLow * (1 + this.params.MP1_FALSE_BREAK_REVERSAL_CONFIRM_PCT / 100);
        if (!reversalConfirmed) return noEntry('假突破已经退出，但反向延伸尚未达到确认幅度');
        modeTag = 'FALSE_BREAK_REVERSAL';
        marginScale = this.params.MP1_FALSE_BREAK_MARGIN_SCALE;
      } else {
        side = st.lastEntrySide;
        const extension = signedPriceMovePct(st.lastEntryPrice, ctx.mark, side);
        if (extension < this.params.MP1_REENTRY_EXTENSION_PCT) {
          return noEntry(
            `同一 P1 周期等待新顺向突破：当前延伸 ${extension.toFixed(2)}% < ${this.params.MP1_REENTRY_EXTENSION_PCT}%`,
          );
        }
        modeTag = `${st.profile.modeTag}_REENTRY`;
        marginScale = st.profile.marginScale;
      }
      profile = {
        ...profile,
        modeTag: modeTag as BreakoutMode,
        marginScale,
      };
    } else {
      if (isPlatform) {
        const beyondPct = event.dir === 'UP'
          ? (ctx.mark / rangeHigh - 1) * 100
          : (rangeLow / ctx.mark - 1) * 100;
        if (event.breakout.status === 'FALSE') {
          const failed = event.dir === 'UP'
            ? ctx.mark <= rangeHigh * (1 - this.params.MP1_FALSE_BREAK_RETURN_PCT / 100)
            : ctx.mark >= rangeLow * (1 + this.params.MP1_FALSE_BREAK_RETURN_PCT / 100);
          if (!failed) return noEntry('突破事件标记为 FALSE，但价格尚未明显回到平台内');
          side = opposite(sideOf(event.dir));
          modeTag = 'FALSE_BREAK_REVERSAL';
          marginScale = this.params.MP1_FALSE_BREAK_MARGIN_SCALE;
        } else {
          if (beyondPct < this.params.MP1_PLATFORM_BREAKOUT_CLEARANCE_PCT) {
            return noEntry(
              `MAJOR P1 已触发，但标记价尚未有效离开平台边界（${beyondPct.toFixed(2)}%）`,
            );
          }
          side = sideOf(event.dir);
          modeTag = 'PLATFORM_BREAKOUT';
        }
        profile = {
          eventId: event.id, p1At, eventDirection: event.dir, modeTag,
          platform: true, rangeHigh, rangeLow, rangePct, driftPct,
          eventPrice: event.price, marginScale,
        };
      } else {
        const extension = event.dir === 'UP'
          ? (ctx.mark / Math.max(event.price, 1e-12) - 1) * 100
          : (Math.max(event.price, 1e-12) / ctx.mark - 1) * 100;
        if (extension < -0.8) return noEntry('价格已明显逆向回撤，放弃追入该加速型异动');
        if (extension > this.params.MP1_MAX_CHASE_FROM_EVENT_PCT) {
          return noEntry(
            `加速型价格已离触发价 ${extension.toFixed(2)}%，超过追入上限 ${this.params.MP1_MAX_CHASE_FROM_EVENT_PCT}%`,
          );
        }
        side = sideOf(event.dir);
        modeTag = 'TREND_ACCELERATION';
        marginScale = this.params.MP1_ACCELERATION_MARGIN_SCALE;
        profile = {
          eventId: event.id, p1At, eventDirection: event.dir, modeTag,
          platform: false, rangeHigh, rangeLow, rangePct, driftPct,
          eventPrice: event.price, marginScale,
        };
      }
    }

    const audit = {
      eventId: event.id, p1At, modeTag, eventDirection: event.dir, tradeSide: side,
      platform: profile.platform, rangeHigh: profile.rangeHigh, rangeLow: profile.rangeLow,
      rangePct: profile.rangePct, driftPct: profile.driftPct, eventPrice: profile.eventPrice,
      marginScale,
    };
    const signal = this.syntheticSignal(event, candles, ctx.now, cycleId, side, audit);
    this.prepared.set(event.symbol, { cycleId, side, profile, price: ctx.mark });
    return {
      want: true, side, modeTag,
      reason: `MAJOR P1 事件驱动入场：${modeTag}，事件方向 ${event.dir}，执行方向 ${side}，风险仓位系数 ${marginScale}`,
      cycleId, marginScale, signal,
    };
  }

  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: StrategyPositionCtx;
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    const { meta, pos, mark, now } = input;
    if (!(mark > 0) || !(pos.entryPrice > 0) || !(pos.margin > 0)) {
      return { exit: false, reason: null, detail: '' };
    }
    const profile = this.states.get(meta.symbol)?.cycleId === meta.trendCycleId
      ? this.states.get(meta.symbol)!.profile
      : parseProfile(meta.signalAtOpen);
    if (!profile) return { exit: false, reason: null, detail: '' };

    const livePct = signedPriceMovePct(pos.entryPrice, mark, pos.side);
    const holdMs = now - pos.openedAt;

    // 平台型：允许正常回踩，但价格明确回到突破边界内，才认定这次突破失效。
    if (profile.platform && holdMs >= FALSE_BREAK_MIN_HOLD_MS) {
      const failed = profile.modeTag === 'FALSE_BREAK_REVERSAL'
        ? (pos.side === 'SHORT'
          ? mark >= profile.rangeHigh * (1 + this.params.MP1_FALSE_BREAK_RETURN_PCT / 100)
          : mark <= profile.rangeLow * (1 - this.params.MP1_FALSE_BREAK_RETURN_PCT / 100))
        : (pos.side === 'LONG'
          ? mark <= profile.rangeHigh * (1 - this.params.MP1_FALSE_BREAK_RETURN_PCT / 100)
          : mark >= profile.rangeLow * (1 + this.params.MP1_FALSE_BREAK_RETURN_PCT / 100));
      if (failed) {
        return {
          exit: true,
          reason: 'BREAKOUT_FALSE_EXIT' as TrendExitReason,
          detail: `平台突破失效：价格重新越过结构失效线，当前顺向价格变动 ${livePct.toFixed(2)}%`,
        };
      }
    }

    if (livePct <= -this.params.MP1_HARD_STOP_PCT) {
      return {
        exit: true,
        reason: 'BREAKOUT_HARD_STOP' as TrendExitReason,
        detail: `重大异动紧急硬止损：逆向价格变动 ${livePct.toFixed(2)}% 达到 -${this.params.MP1_HARD_STOP_PCT}%`,
      };
    }

    if (livePct >= this.params.MP1_TAKE_PROFIT_PCT) {
      return {
        exit: true,
        reason: 'BREAKOUT_TAKE_PROFIT' as TrendExitReason,
        detail: `重大异动固定止盈：顺向价格变动 ${livePct.toFixed(2)}% 达到 ${this.params.MP1_TAKE_PROFIT_PCT}%`,
      };
    }

    const leverage = pos.qty * pos.entryPrice / pos.margin;
    const dbPeakPricePct = leverage > 0 && meta.mfe != null ? Math.max(0, meta.mfe / leverage) : 0;
    const state = this.states.get(meta.symbol);
    const peakPct = Math.max(dbPeakPricePct, state?.cycleId === meta.trendCycleId ? state.peakFavorablePct : 0);
    if (peakPct >= this.params.MP1_TRAIL_START_PCT && peakPct - livePct >= this.params.MP1_TRAIL_DISTANCE_PCT) {
      return {
        exit: true,
        reason: 'BREAKOUT_TRAIL_STOP' as TrendExitReason,
        detail: `重大异动移动止盈：有利价格峰值 ${peakPct.toFixed(2)}%，现回撤 ${(peakPct - livePct).toFixed(2)}%`,
      };
    }
    if (peakPct >= this.params.MP1_BREAKEVEN_ARM_PCT && livePct <= this.params.MP1_BREAKEVEN_OFFSET_PCT) {
      return {
        exit: true,
        reason: 'BREAKOUT_BREAKEVEN' as TrendExitReason,
        detail: `重大异动保本保护：峰值浮盈 ${peakPct.toFixed(2)}%，价格回落至 ${livePct.toFixed(2)}%`,
      };
    }

    return { exit: false, reason: null, detail: '' };
  }

  nextRound(symbol: string, cycleId: string): number {
    const st = this.states.get(symbol);
    if (!st || st.cycleId !== cycleId) return 1;
    return st.round + 1;
  }

  onOpen(symbol: string, cycleId: string, barTime: number | null, now: number): void {
    const prep = this.prepared.get(symbol);
    const prev = this.states.get(symbol);
    const sameCycle = prev?.cycleId === cycleId;
    const profile = prep?.cycleId === cycleId
      ? prep.profile
      : sameCycle && prev
        ? prev.profile
        : {
            eventId: cycleId, p1At: now, eventDirection: 'UP' as const,
            modeTag: 'TREND_ACCELERATION', platform: false,
            rangeHigh: 0, rangeLow: 0, rangePct: 0, driftPct: 0, eventPrice: 0, marginScale: 1,
          };
    this.states.set(symbol, {
      cycleId,
      round: sameCycle && prev ? prev.round + 1 : 1,
      lastEntryAt: now,
      lastEntryPrice: prep?.cycleId === cycleId ? prep.price : 0,
      lastEntrySide: prep?.cycleId === cycleId ? prep.side : (sameCycle && prev ? prev.lastEntrySide : 'LONG'),
      lastExitAt: sameCycle && prev ? prev.lastExitAt : null,
      lastExitReason: sameCycle && prev ? prev.lastExitReason : null,
      peakFavorablePct: 0,
      profile,
    });
    this.prepared.delete(symbol);
    this.flush(symbol);
  }

  onClose(symbol: string, cycleId: string, reason: string, now: number): void {
    const prev = this.states.get(symbol);
    if (prev && prev.cycleId === cycleId) {
      this.states.set(symbol, { ...prev, lastExitAt: now, lastExitReason: reason });
      this.flush(symbol);
    }
  }

  exportState(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [sym, state] of this.states) out[sym] = state;
    return out;
  }

  importState(raw: unknown): void {
    this.states.clear();
    if (!raw || typeof raw !== 'object') return;
    for (const [symbol, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const s = value as Partial<SymbolState>;
      if (
        typeof s.cycleId !== 'string' || typeof s.round !== 'number' ||
        typeof s.lastEntryAt !== 'number' || typeof s.lastEntryPrice !== 'number' ||
        (s.lastEntrySide !== 'LONG' && s.lastEntrySide !== 'SHORT') ||
        !s.profile || typeof s.profile !== 'object'
      ) continue;
      const p = s.profile as Partial<BreakoutProfile>;
      if (
        typeof p.eventId !== 'string' || typeof p.p1At !== 'number' ||
        typeof p.platform !== 'boolean' || typeof p.modeTag !== 'string' ||
        typeof p.rangeHigh !== 'number' || typeof p.rangeLow !== 'number' ||
        typeof p.eventDirection !== 'string' || typeof p.marginScale !== 'number'
      ) continue;
      this.states.set(symbol, {
        cycleId: s.cycleId,
        round: Math.max(0, Math.floor(s.round)),
        lastEntryAt: s.lastEntryAt,
        lastEntryPrice: s.lastEntryPrice,
        lastEntrySide: s.lastEntrySide,
        lastExitAt: typeof s.lastExitAt === 'number' ? s.lastExitAt : null,
        lastExitReason: typeof s.lastExitReason === 'string' ? s.lastExitReason : null,
        peakFavorablePct: typeof s.peakFavorablePct === 'number' ? s.peakFavorablePct : 0,
        profile: {
          eventId: p.eventId,
          p1At: p.p1At,
          eventDirection: p.eventDirection as 'UP' | 'DOWN',
          modeTag: p.modeTag,
          platform: p.platform,
          rangeHigh: p.rangeHigh,
          rangeLow: p.rangeLow,
          rangePct: typeof p.rangePct === 'number' ? p.rangePct : 0,
          driftPct: typeof p.driftPct === 'number' ? p.driftPct : 0,
          eventPrice: typeof p.eventPrice === 'number' ? p.eventPrice : 0,
          marginScale: p.marginScale,
        },
      });
    }
  }

  private syntheticSignal(
    event: EnhancedEventDTO,
    candles: TrendCandle[],
    now: number,
    cycleId: string,
    side: Side,
    audit: {
      eventId: string; p1At: number; modeTag: string; eventDirection: 'UP' | 'DOWN';
      tradeSide: Side; platform: boolean; rangeHigh: number; rangeLow: number;
      rangePct: number; driftPct: number; eventPrice: number; marginScale: number;
    },
  ): UnifiedTrendSignal & { breakoutTrade: typeof audit } {
    const lastBarTime = closedBefore(candles, now).at(-1)?.t ?? null;
    const emptyFeatures = {
      atr: 0, atrPct: 0, realizedVolPct: 0, volPercentile: -1, volRegime: 'NORMAL' as const,
      efficiencyRatio: 0, upperWickPct: 0, lowerWickPct: 0,
      breakout: 'none' as const, falseBreakout: false, barsUsed: 0,
    };
    const noHtf = { dir: 'flat' as const, efficiencyRatio: 0, returnPct: 0, valid: false, bars: 0 };
    const direction = dirOf(side);
    return {
      symbol: event.symbol,
      market: 'futures',
      interval: '1m',
      phase: side === 'LONG' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN',
      direction,
      trendCycleId: cycleId,
      trendStartedAt: event.p1At ?? event.firstAt,
      endPendingSince: null,
      endEvidenceBars: 0,
      endedAt: null,
      endReason: null,
      score: 0,
      strength: 0,
      confirmCount: 0,
      features: { ...emptyFeatures, barsUsed: Math.min(candles.length, 60) },
      htf5m: noHtf,
      htf15m: noHtf,
      htfAgree: null,
      lastBarTime,
      lastKlineAt: now,
      dataFresh: true,
      dataUnavailableReason: null,
      anomaly: {
        dir: event.dir, level: event.level, priority: event.priority, active: event.state === 'ACTIVE',
        lastAt: event.p1At ?? event.updatedAt,
      },
      conflict: direction !== (event.dir === 'UP' ? 'up' : 'down'),
      reason: `重大异动事件驱动：${audit.modeTag}；不使用 UTE 趋势分数作为入场依据`,
      changedAt: now,
      breakoutTrade: audit,
    };
  }

  private flush(symbol: string): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(this.id, symbol, JSON.stringify(this.states.get(symbol) ?? {}));
    } catch {
      // 状态持久化失败不影响交易循环；重启后由 meta MFE 与事件新鲜度护栏兜底。
    }
  }
}
