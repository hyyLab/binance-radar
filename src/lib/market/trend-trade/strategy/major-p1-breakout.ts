import type { EnhancedEventDTO } from '../../enhanced/types';
import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendTradeMetaRow } from '../repo';
import type { StrategyAnomalyEntryVerdict, StrategyExitVerdict, StrategyMarketCtx, TrendStrategy } from './types';

export const MAJOR_P1_BREAKOUT = {
  MP1B_EVENT_FRESH_MS: 30_000,
  MP1B_MAX_CHASE_1M_PCT: 5,
  MP1B_MAX_CHASE_5M_PCT: 10,
  MP1B_FALSE_BREAKOUT_REENTRY_PCT: 0.6,
  MP1B_STRUCTURE_INVALIDATION_PCT: 0.8,
  MP1B_STRUCTURE_BREACH_TICKS: 2,
  MP1B_STOP_LOSS_PCT: 1.8,
  MP1B_TRAIL_ARM_PCT: 2.0,
  MP1B_TRAIL_GIVEBACK_PCT: 1.0,
  MP1B_MAX_HOLD_WITHOUT_EXPANSION_MS: 600_000,
  MP1B_MAX_ROUNDS_PER_EVENT: 8,
  MP1B_ACCELERATION_RISK_MULTIPLIER: 0.5,
  MP1B_PENDING_BREAKOUT_RISK_MULTIPLIER: 0.7,
  MP1B_FALSE_BREAKOUT_RISK_MULTIPLIER: 0.6,
};
export type MajorP1BreakoutParams = Partial<typeof MAJOR_P1_BREAKOUT>;

export class MajorP1BreakoutStrategy implements TrendStrategy {
  readonly id = 'major-p1-breakout-v1';
  readonly name = '重大异动突破';
  readonly description = '独立消费 MAJOR P1 事件；确认突破顺势，假突破确认后反向；价格硬止损与移动止盈。';
  readonly scanIntervalMs = 2_000;
  readonly params = { ...MAJOR_P1_BREAKOUT };
  bindPersistence(_fn: (strategyId: string, symbol: string, json: string) => void): void {}
  observe(_symbol: string, _mark: number, _now: number): void {}
  evaluateEntry(_signal: UnifiedTrendSignal, _ctx: StrategyMarketCtx) {
    return { want: false, side: null, modeTag: '-', reason: '此算法只接受独立 MAJOR P1 事件入口' } as const;
  }
  evaluateAnomalyEntry(_event: EnhancedEventDTO, _ctx: StrategyMarketCtx): StrategyAnomalyEntryVerdict {
    return { want: false, side: null, modeTag: '-', reason: '待实现', cycleId: null, evidenceAt: null };
  }
  evaluateExit(_input: { meta: TrendTradeMetaRow; pos: { entryPrice: number; qty: number; margin: number; side: 'LONG' | 'SHORT'; openedAt: number }; mark: number; signal: UnifiedTrendSignal | null; now: number }): StrategyExitVerdict {
    return { exit: false, reason: null, detail: '' };
  }
  nextRound(_symbol: string, _cycleId: string): number { return 1; }
  onOpen(_symbol: string, _cycleId: string, _barTime: number | null, _now: number): void {}
  onClose(_symbol: string, _cycleId: string, _reason: string, _now: number): void {}
  exportState(): Record<string, unknown> { return {}; }
  importState(_raw: unknown): void {}
}
