// ---------- 策略：重大异动突破 v1（major-p1-breakout-v1） ----------
// 只响应新 MAJOR P1 异动，不依赖 TrendWatchService 的 20 个标的趋势池，也不等待 UTE 确认。
// AutoPaperTrader 统一处理模拟成交、资金、手续费、滑点、幂等、持仓持久化与强平。
// 所有百分比均指标的价格变动而非保证金收益率；以下阈值为首版工程值，需历史回放校准。

import type { Candle1m } from '../../enhanced/klines';
import type { EnhancedEventDTO } from '../../enhanced/types';
import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendExitReason } from '../config';
import type { TrendTradeMetaRow } from '../repo';
import type {
  StrategyEntryVerdict,
  StrategyMajorEventEntryInput,
  StrategyMajorEventEntryVerdict,
  StrategyMarketCtx,
  StrategyExitVerdict,
  TrendStrategy,
} from './types';

export const MAJOR_P1_BREAKOUT = {
  MP1_MAX_P1_AGE_MS: 12_000,
  MP1_MIN_QV24H: 5_000_000,
  MP1_MIN_QV1M: 30_000,
  MP1_PLATFORM_LOOKBACK_BARS: 20,
  MP1_PLATFORM_MIN_BARS: 12,
  MP1_PLATFORM_MAX_RANGE_PCT: 7.5,
  MP1_PLATFORM_MAX_DRIFT_PCT: 2.5,
  MP1_PLATFORM_BREAK_MIN_PCT: 0.35,
  MP1_ACCELERATION_MIN_DRIFT_PCT: 2.8,
  MP1_BREAKOUT_FAILURE_BACK_IN_PCT: 0.55,
  MP1_HARD_STOP_PCT: 2.2,
  MP1_ACCEL_HARD_STOP_PCT: 1.8,
  MP1_TRAIL_START_PCT: 2.2,
  MP1_TRAIL_GAP_PCT: 1.2,
  MP1_ACCEL_TAKE_PCT: 4.0,
  MP1_REENTRY_MOVE_PCT: 1.5,
  MP1_REENTRY_MIN_GAP_MS: 2_000,
  MP1_MAX_ROUNDS_PER_EVENT: 8,
  MP1_STRUCTURE_FAIL_OBSERVATIONS: 2,
} as const;

export type MajorP1BreakoutParams = Partial<typeof MAJOR_P1_BREAKOUT>;

interface PreparedEntry {
  cycleId: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  eventId: string;
  p1At: number;
  modeTag: string;
  preparedAt: number;
}

interface SymbolState {
  cycleId: string | null;
  round: number;
  lastEntryPrice: number | null;
  lastEntrySide: 'LONG' | 'SHORT' | null;
  lastEventId: string | null;
  lastP1At: number | null;
  lastExitAt: number | null;
  lastExitPrice: number | null;
  lastExitReason: string | null;
  prepared: PreparedEntry | null;
  exitFailurePositionId: string | null;
  exitFailureCount: number;
  exitFailureLastAt: number | null;
}

interface EventTradeSnapshot {
  kind?: string;
  modeTag?: string;
  eventId?: string;
  p1At?: number;
  platformHigh?: number | null;
  platformLow?: number | null;
  breakoutBaseline?: number | null;
  falseBreakout?: boolean;
  eventDir?: 'UP' | 'DOWN';
}

function defaultState(): SymbolState {
  return {
    cycleId: null,
    round: 0,
    lastEntryPrice: null,
    lastEntrySide: null,
    lastEventId: null,
    lastP1At: null,
    lastExitAt: null,
    lastExitPrice: null,
    lastExitReason: null,
    prepared: null,
    exitFailurePositionId: null,
    exitFailureCount: 0,
    exitFailureLastAt: null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Signed underlying-price move; positive is favorable for the position. */
function signedPriceMovePct(side: 'LONG' | 'SHORT', reference: number, mark: number): number {
  if (!(reference > 0) || !(mark > 0)) return 0;
  const raw = (mark / reference - 1) * 100;
  return side === 'LONG' ? raw : -raw;
}

function parseTradeSnapshot(meta: TrendTradeMetaRow): EventTradeSnapshot | null {
  try {
    const raw = JSON.parse(meta.signalAtOpen) as { eventTrade?: EventTradeSnapshot };
    if (raw?.eventTrade?.kind === 'major-p1-breakout-v1') return raw.eventTrade;
  } catch {
    // Damaged/legacy snapshot: never infer event structure from unrelated positions.
  }
  return null;
}

function peakPriceMovePct(metaMfe: number | null | undefined, pos: {
  entryPrice: number; qty: number; margin: number;
}): number {
  const notional = pos.entryPrice * pos.qty;
  if (metaMfe == null || !(notional > 0) || !(pos.margin > 0)) return 0;
  // meta.mfe is margin PnL %, convert it to underlying price PnL %.
  return metaMfe * pos.margin / notional;
}

export class MajorP1BreakoutStrategy implements TrendStrategy {
  readonly id = 'major-p1-breakout-v1';
  readonly name = '重大异动突破';
  readonly description =
    '只响应新 MAJOR P1 事件，不依赖趋势池/UTE 入场；优先平台突破，加速行情降低风险预算，结构失效退出并允许新脉冲再入场。';
  readonly eventDriven = true;
  readonly params: typeof MAJOR_P1_BREAKOUT;

  private states = new Map<string, SymbolState>();
  private onStateChange: ((strategyId: string, symbol: string, json: string) => void) | null = null;

  constructor(params?: MajorP1BreakoutParams) {
    this.params = { ...MAJOR_P1_BREAKOUT, ...(params ?? {}) };
  }

  bindPersistence(fn: (strategyId: string, symbol: string, json: string) => void): void {
    this.onStateChange = fn;
  }

  observe(_symbol: string, _mark: number, _now: number): void {
    // The event loop uses the current mark; shared AutoPaperTrader samples MFE/MAE separately.
  }

  /** This strategy deliberately does not consume UTE pool signals for entry. */
  evaluateEntry(_signal: UnifiedTrendSignal, _ctx: StrategyMarketCtx): StrategyEntryVerdict {
    return {
      want: false,
      side: null,
      modeTag: '-',
      reason: '重大异动突破只接受新 MAJOR P1 事件，不消费 UTE 趋势池入场信号',
    };
  }

  private eventCycleId(event: EnhancedEventDTO): string {
    return 'MP1:' + event.id + ':' + (event.p1At ?? event.firstAt);
  }

  private classify(
    event: EnhancedEventDTO,
    candles: Candle1m[],
    side: 'LONG' | 'SHORT',
    mark: number,
  ): {
    modeTag: string;
    platformHigh: number | null;
    platformLow: number | null;
    rangePct: number | null;
    driftPct: number | null;
    riskMultiplier: number;
  } {
    const bars = [...candles]
      .filter((bar) => Number.isFinite(bar.t) && bar.t > 0 && bar.h > 0 && bar.l > 0 && bar.o > 0 && bar.c > 0)
      .sort((a, b) => a.t - b.t)
      .slice(-this.params.MP1_PLATFORM_LOOKBACK_BARS);

    let platformHigh: number | null = null;
    let platformLow: number | null = null;
    let rangePct: number | null = null;
    let driftPct: number | null = null;
    if (bars.length >= this.params.MP1_PLATFORM_MIN_BARS) {
      platformHigh = Math.max(...bars.map((bar) => bar.h));
      platformLow = Math.min(...bars.map((bar) => bar.l));
      const mid = (platformHigh + platformLow) / 2;
      rangePct = mid > 0 ? ((platformHigh - platformLow) / mid) * 100 : null;
      driftPct = bars[0].o > 0 ? ((bars[bars.length - 1].c / bars[0].o) - 1) * 100 : null;
    }

    const crossedPlatform = side === 'LONG'
      ? platformHigh != null && mark >= platformHigh * (1 + this.params.MP1_PLATFORM_BREAK_MIN_PCT / 100)
      : platformLow != null && mark <= platformLow * (1 - this.params.MP1_PLATFORM_BREAK_MIN_PCT / 100);
    const compactPlatform =
      crossedPlatform &&
      bars.length >= this.params.MP1_PLATFORM_MIN_BARS &&
      rangePct != null &&
      rangePct <= this.params.MP1_PLATFORM_MAX_RANGE_PCT &&
      driftPct != null &&
      Math.abs(driftPct) <= this.params.MP1_PLATFORM_MAX_DRIFT_PCT;

    if (compactPlatform) {
      return { modeTag: 'PLATFORM_BREAKOUT', platformHigh, platformLow, rangePct, driftPct, riskMultiplier: 1 };
    }

    const directionalDrift = driftPct == null ? 0 : side === 'LONG' ? driftPct : -driftPct;
    const accelerated =
      directionalDrift >= this.params.MP1_ACCELERATION_MIN_DRIFT_PCT ||
      Math.abs(event.chg1m ?? 0) >= 2.5 ||
      Math.abs(event.chg5m ?? 0) >= 4.5;
    if (accelerated) {
      return { modeTag: 'ACCELERATION', platformHigh, platformLow, rangePct, driftPct, riskMultiplier: 0.55 };
    }
    if (event.breakout.status === 'CONFIRMED') {
      return { modeTag: 'CONFIRMED_BREAKOUT', platformHigh, platformLow, rangePct, driftPct, riskMultiplier: 0.7 };
    }
    return { modeTag: 'MAJOR_MOMENTUM', platformHigh, platformLow, rangePct, driftPct, riskMultiplier: 0.5 };
  }

  evaluateMajorEventEntry(input: StrategyMajorEventEntryInput): StrategyMajorEventEntryVerdict | null {
    const { event, candles, quoteVolume24h, ctx } = input;
    if (event.state !== 'ACTIVE' || event.level !== 'MAJOR') return null;

    const currentP1 = event.priority === 'P1';
    const isFalseBreakout = event.breakout.status === 'FALSE';
    if (!currentP1 && !(event.peakPriority === 'P1' && isFalseBreakout)) return null;

    const cycleId = this.eventCycleId(event);
    const state = this.states.get(event.symbol) ?? defaultState();
    const sameCycle = state.cycleId === cycleId;
    const p1At = event.p1At ?? event.firstAt;
    const ageMs = ctx.now - p1At;

    // First entry must be fresh; same-event re-entry is governed by new directional price evidence.
    if (currentP1 && (ageMs < 0 || (ageMs > this.params.MP1_MAX_P1_AGE_MS && !sameCycle))) return null;
    if (!(ctx.mark > 0) || !Number.isFinite(quoteVolume24h) || quoteVolume24h < this.params.MP1_MIN_QV24H) return null;
    if (!Number.isFinite(event.quoteVolume1m ?? 0) || (event.quoteVolume1m ?? 0) < this.params.MP1_MIN_QV1M) return null;
    if (ctx.openSymbols.has(event.symbol)) return null;

    const round = this.nextRound(event.symbol, cycleId);
    if (round > this.params.MP1_MAX_ROUNDS_PER_EVENT) return null;

    let side: 'LONG' | 'SHORT' = event.dir === 'UP' ? 'LONG' : 'SHORT';
    let modeTag = '';
    let riskMultiplier = 0.7;
    let platformHigh: number | null = null;
    let platformLow: number | null = null;
    let rangePct: number | null = null;
    let driftPct: number | null = null;

    if (isFalseBreakout) {
      const baseline = finiteOrNull(event.breakout.baseline);
      const previousTradeStopped =
        sameCycle && state.round >= 1 && state.lastExitReason === 'STOP_LOSS' && state.lastExitPrice != null;
      if (!(baseline != null && baseline > 0 && previousTradeStopped)) return null;
      const returnedInside = event.dir === 'UP'
        ? ctx.mark <= baseline * (1 - this.params.MP1_BREAKOUT_FAILURE_BACK_IN_PCT / 100)
        : ctx.mark >= baseline * (1 + this.params.MP1_BREAKOUT_FAILURE_BACK_IN_PCT / 100);
      side = event.dir === 'UP' ? 'SHORT' : 'LONG';
      if (!returnedInside || state.lastEntrySide === side) return null;
      modeTag = 'FALSE_BREAKOUT_REVERSAL';
      riskMultiplier = 0.5;
    } else {
      const shape = this.classify(event, candles, side, ctx.mark);
      modeTag = shape.modeTag;
      platformHigh = shape.platformHigh;
      platformLow = shape.platformLow;
      rangePct = shape.rangePct;
      driftPct = shape.driftPct;
      riskMultiplier = shape.riskMultiplier;

      if (event.breakout.status !== 'CONFIRMED' && event.direction.tendency !== 'UNKNOWN') {
        if ((event.dir === 'UP' && event.direction.tendency === 'SHORT') ||
            (event.dir === 'DOWN' && event.direction.tendency === 'LONG')) return null;
      }
    }

    if (sameCycle && state.round > 0) {
      if (state.lastExitAt == null || ctx.now - state.lastExitAt < this.params.MP1_REENTRY_MIN_GAP_MS) return null;
      const confirmedFailureReverse =
        isFalseBreakout && state.lastExitReason === 'STOP_LOSS' &&
        state.lastEntrySide != null && state.lastEntrySide !== side;
      if (!confirmedFailureReverse) {
        if (state.lastEntrySide !== side || !(state.lastExitPrice != null && state.lastExitPrice > 0)) return null;
        if (signedPriceMovePct(side, state.lastExitPrice, ctx.mark) < this.params.MP1_REENTRY_MOVE_PCT) return null;
      }
    }

    const metadata: Record<string, unknown> = {
      eventId: event.id,
      p1At,
      eventDir: event.dir,
      breakoutStatus: event.breakout.status,
      breakoutBaseline: finiteOrNull(event.breakout.baseline),
      platformHigh,
      platformLow,
      rangePct,
      driftPct,
      falseBreakout: isFalseBreakout,
      side,
    };

    // A new event cycle must reset the previous event's round counter before the shared executor calls nextRound().
    const preparedState = sameCycle ? state : defaultState();
    this.states.set(event.symbol, {
      ...preparedState,
      cycleId,
      prepared: {
        cycleId,
        side,
        entryPrice: ctx.mark,
        eventId: event.id,
        p1At,
        modeTag,
        preparedAt: ctx.now,
      },
    });

    return {
      want: true,
      side,
      modeTag,
      reason:
        'MAJOR P1 即时入场：' + modeTag +
        '，方向=' + (side === 'LONG' ? '做多' : '做空') +
        '，24h 成交额=' + Math.round(quoteVolume24h).toLocaleString('en-US') +
        '，1m 成交额=' + Math.round(event.quoteVolume1m ?? 0).toLocaleString('en-US') +
        '，P1 年龄=' + ageMs + 'ms；不等待 UTE 确认',
      riskMultiplier,
      eventCycleId: cycleId,
      metadata,
    };
  }

  evaluateExit(input: {
    meta: TrendTradeMetaRow;
    pos: { entryPrice: number; qty: number; margin: number; side: 'LONG' | 'SHORT'; openedAt: number };
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    const { meta, pos, mark, now } = input;
    const trade = parseTradeSnapshot(meta);
    if (!trade || !(mark > 0) || !(pos.entryPrice > 0) || !(pos.qty > 0)) {
      return { exit: false, reason: null, detail: '' };
    }

    const modeTag = typeof trade.modeTag === 'string' ? trade.modeTag : '';
    const favorablePct = signedPriceMovePct(pos.side, pos.entryPrice, mark);
    const hardStopPct = modeTag === 'ACCELERATION'
      ? this.params.MP1_ACCEL_HARD_STOP_PCT
      : this.params.MP1_HARD_STOP_PCT;
    if (favorablePct <= -hardStopPct) {
      return {
        exit: true,
        reason: 'STOP_LOSS' as TrendExitReason,
        detail: '重大异动硬止损：价格逆向 ' + Math.abs(favorablePct).toFixed(2) + '% ≥ ' + hardStopPct + '%',
      };
    }

    const state = this.states.get(meta.symbol) ?? defaultState();
    if (modeTag === 'PLATFORM_BREAKOUT' || modeTag === 'FALSE_BREAKOUT_REVERSAL') {
      const platformHigh = finiteOrNull(trade.platformHigh);
      const platformLow = finiteOrNull(trade.platformLow);
      const baseline = finiteOrNull(trade.breakoutBaseline);
      let returnedInside = false;
      if (modeTag === 'FALSE_BREAKOUT_REVERSAL' && baseline != null && baseline > 0) {
        returnedInside = trade.eventDir === 'UP'
          ? pos.side === 'SHORT' && mark >= baseline * (1 + this.params.MP1_BREAKOUT_FAILURE_BACK_IN_PCT / 100)
          : pos.side === 'LONG' && mark <= baseline * (1 - this.params.MP1_BREAKOUT_FAILURE_BACK_IN_PCT / 100);
      } else {
        returnedInside = pos.side === 'LONG'
          ? platformHigh != null && mark <= platformHigh * (1 - this.params.MP1_BREAKOUT_FAILURE_BACK_IN_PCT / 100)
          : platformLow != null && mark >= platformLow * (1 + this.params.MP1_BREAKOUT_FAILURE_BACK_IN_PCT / 100);
      }

      if (returnedInside) {
        if (state.exitFailurePositionId !== meta.positionId) {
          state.exitFailurePositionId = meta.positionId;
          state.exitFailureCount = 1;
          state.exitFailureLastAt = now;
        } else if (state.exitFailureLastAt == null || now - state.exitFailureLastAt >= 5_000) {
          state.exitFailureCount += 1;
          state.exitFailureLastAt = now;
        }
        this.states.set(meta.symbol, state);
        if (state.exitFailureCount >= this.params.MP1_STRUCTURE_FAIL_OBSERVATIONS) {
          return {
            exit: true,
            reason: 'STOP_LOSS' as TrendExitReason,
            detail: '突破结构失效：价格连续 ' + state.exitFailureCount + ' 次处于失效区间，按假突破退出',
          };
        }
      } else {
        state.exitFailurePositionId = meta.positionId;
        state.exitFailureCount = 0;
        state.exitFailureLastAt = now;
        this.states.set(meta.symbol, state);
      }
    }

    if (modeTag === 'ACCELERATION' && favorablePct >= this.params.MP1_ACCEL_TAKE_PCT) {
      return {
        exit: true,
        reason: 'SPIKE_TAKE' as TrendExitReason,
        detail: '加速型动量兑现：顺向价格运动 ' + favorablePct.toFixed(2) +
          '% ≥ ' + this.params.MP1_ACCEL_TAKE_PCT + '%',
      };
    }

    const peakPct = Math.max(favorablePct, peakPriceMovePct(meta.mfe, pos));
    if (peakPct >= this.params.MP1_TRAIL_START_PCT &&
        peakPct - favorablePct >= this.params.MP1_TRAIL_GAP_PCT) {
      return {
        exit: true,
        reason: 'TRAIL_TAKE' as TrendExitReason,
        detail: '重大异动移动止盈：顺向峰值约 ' + peakPct.toFixed(2) +
          '%，当前回撤 ' + (peakPct - favorablePct).toFixed(2) +
          '% ≥ ' + this.params.MP1_TRAIL_GAP_PCT + '%',
      };
    }
    return { exit: false, reason: null, detail: '' };
  }

  nextRound(symbol: string, cycleId: string): number {
    const state = this.states.get(symbol);
    if (!state || !cycleId) return 1;
    return state.cycleId === cycleId ? state.round + 1 : 1;
  }

  onOpen(symbol: string, cycleId: string, _barTime: number | null, now: number): void {
    const previous = this.states.get(symbol) ?? defaultState();
    const sameCycle = previous.cycleId === cycleId;
    const prepared = previous.prepared &&
      previous.prepared.cycleId === cycleId &&
      now - previous.prepared.preparedAt <= 30_000
      ? previous.prepared
      : null;
    this.states.set(symbol, {
      ...previous,
      cycleId,
      round: sameCycle ? previous.round + 1 : 1,
      lastEntryPrice: prepared?.entryPrice ?? previous.lastEntryPrice,
      lastEntrySide: prepared?.side ?? previous.lastEntrySide ?? 'LONG',
      lastEventId: prepared?.eventId ?? previous.lastEventId,
      lastP1At: prepared?.p1At ?? previous.lastP1At,
      prepared: null,
      exitFailurePositionId: null,
      exitFailureCount: 0,
      exitFailureLastAt: null,
    });
    this.flush(symbol);
  }

  onClose(symbol: string, cycleId: string, reason: string, now: number, exitPrice?: number): void {
    const previous = this.states.get(symbol);
    if (!previous || previous.cycleId !== cycleId) return;
    this.states.set(symbol, {
      ...previous,
      lastExitAt: now,
      lastExitPrice: typeof exitPrice === 'number' && exitPrice > 0 ? exitPrice : previous.lastExitPrice,
      lastExitReason: reason,
      prepared: null,
      exitFailurePositionId: null,
      exitFailureCount: 0,
      exitFailureLastAt: null,
    });
    this.flush(symbol);
  }

  exportState(): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [symbol, state] of this.states) output[symbol] = state;
    return output;
  }

  importState(raw: unknown): void {
    this.states.clear();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [symbol, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Partial<SymbolState>;
      if (record.cycleId !== undefined && record.cycleId !== null && typeof record.cycleId !== 'string') continue;

      let prepared: PreparedEntry | null = null;
      if (record.prepared && typeof record.prepared === 'object' && !Array.isArray(record.prepared)) {
        const p = record.prepared as Partial<PreparedEntry>;
        if (
          typeof p.cycleId === 'string' &&
          (p.side === 'LONG' || p.side === 'SHORT') &&
          typeof p.entryPrice === 'number' && Number.isFinite(p.entryPrice) &&
          typeof p.eventId === 'string' &&
          typeof p.p1At === 'number' && Number.isFinite(p.p1At) &&
          typeof p.modeTag === 'string' &&
          typeof p.preparedAt === 'number' && Number.isFinite(p.preparedAt)
        ) prepared = p as PreparedEntry;
      }

      this.states.set(symbol, {
        cycleId: typeof record.cycleId === 'string' ? record.cycleId : null,
        round: typeof record.round === 'number' && Number.isFinite(record.round) ? Math.max(0, Math.floor(record.round)) : 0,
        lastEntryPrice: finiteOrNull(record.lastEntryPrice),
        lastEntrySide: record.lastEntrySide === 'LONG' || record.lastEntrySide === 'SHORT' ? record.lastEntrySide : null,
        lastEventId: typeof record.lastEventId === 'string' ? record.lastEventId : null,
        lastP1At: finiteOrNull(record.lastP1At),
        lastExitAt: finiteOrNull(record.lastExitAt),
        lastExitPrice: finiteOrNull(record.lastExitPrice),
        lastExitReason: typeof record.lastExitReason === 'string' ? record.lastExitReason : null,
        prepared,
        exitFailurePositionId: typeof record.exitFailurePositionId === 'string' ? record.exitFailurePositionId : null,
        exitFailureCount: typeof record.exitFailureCount === 'number' && Number.isFinite(record.exitFailureCount) ? Math.max(0, Math.floor(record.exitFailureCount)) : 0,
        exitFailureLastAt: finiteOrNull(record.exitFailureLastAt),
      });
    }
  }

  private flush(symbol: string): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(this.id, symbol, JSON.stringify(this.states.get(symbol) ?? defaultState()));
    } catch {
      // State persistence is best-effort; never block a trade decision.
    }
  }
}
