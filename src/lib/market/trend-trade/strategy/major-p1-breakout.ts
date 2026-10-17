// MAJOR P1 重大异动突破 v1：事件驱动，不依赖 TrendWatch 候选池或 UTE 确认。
// 所有涨跌阈值均为标的价格百分比；是回放起点，不代表已验证的最优参数。
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
  MP1B_TRAIL_ARM_PCT: 2,
  MP1B_TRAIL_GIVEBACK_PCT: 1,
  MP1B_MAX_HOLD_WITHOUT_EXPANSION_MS: 600_000,
  MP1B_MAX_ROUNDS_PER_EVENT: 8,
  MP1B_ACCELERATION_RISK_MULTIPLIER: 0.5,
  MP1B_PENDING_BREAKOUT_RISK_MULTIPLIER: 0.7,
  MP1B_FALSE_BREAKOUT_RISK_MULTIPLIER: 0.6,
};
export type MajorP1BreakoutParams = Partial<typeof MAJOR_P1_BREAKOUT>;
type State = {
  cycleId: string | null; round: number; lastEntryEvidenceAt: number | null;
  lastEntryAt: number | null; lastExitAt: number | null; lastExitReason: string | null;
  structureBreachCount: number;
};
type Candidate = { cycleId: string; evidenceAt: number };

const noEntry = (reason: string): StrategyAnomalyEntryVerdict => ({
  want: false, side: null, modeTag: '-', reason, cycleId: null, evidenceAt: null,
});
const absPct = (v: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.abs(v) : null;
const cycleOf = (e: EnhancedEventDTO) => `MP1:${e.id}:${e.p1At ?? e.firstAt}`;
function evidenceAt(e: EnhancedEventDTO, now: number): number {
  const times = e.evidence.map(x => x.at).filter(t => Number.isFinite(t) && t > 0 && t <= now);
  return Math.max(e.p1At ?? e.firstAt, ...times);
}

export class MajorP1BreakoutStrategy implements TrendStrategy {
  readonly id = 'major-p1-breakout-v1';
  readonly name = '重大异动突破';
  readonly description = '独立消费 MAJOR P1 事件；确认突破顺向，假突破确认后反向，采用较宽价格止损和移动止盈。';
  readonly scanIntervalMs = 2_000;
  readonly params: typeof MAJOR_P1_BREAKOUT;
  private states = new Map<string, State>();
  private candidates = new Map<string, Candidate>();
  private onStateChange: ((id: string, symbol: string, json: string) => void) | null = null;

  constructor(params?: MajorP1BreakoutParams) { this.params = { ...MAJOR_P1_BREAKOUT, ...(params ?? {}) }; }
  bindPersistence(fn: (id: string, symbol: string, json: string) => void): void { this.onStateChange = fn; }
  observe(_symbol: string, _mark: number, _now: number): void {}

  evaluateEntry(_signal: UnifiedTrendSignal, _ctx: StrategyMarketCtx) {
    return { want: false, side: null, modeTag: '-', reason: '本算法只由独立 MAJOR P1 事件触发' } as const;
  }

  evaluateAnomalyEntry(e: EnhancedEventDTO, ctx: StrategyMarketCtx): StrategyAnomalyEntryVerdict {
    this.candidates.delete(e.symbol);
    if (e.state !== 'ACTIVE' || e.level !== 'MAJOR' || e.priority !== 'P1') return noEntry('非活跃 MAJOR P1');
    if (!(ctx.mark > 0)) return noEntry('标记价不可用');
    if (ctx.openSymbols.has(e.symbol)) return noEntry('同币种已有持仓');
    if (e.dir !== 'UP' && e.dir !== 'DOWN') return noEntry('异动方向不明确');

    const p1At = e.p1At ?? e.firstAt;
    if (!(p1At > 0) || p1At > ctx.now + 2_000) return noEntry('P1 时间戳无效');
    const cycleId = cycleOf(e), evAt = evidenceAt(e, ctx.now), round = this.nextRound(e.symbol, cycleId);
    const st = this.states.get(e.symbol), same = st?.cycleId === cycleId;
    if (round > this.params.MP1B_MAX_ROUNDS_PER_EVENT) return noEntry('单事件轮次已达上限');
    if (round === 1 && ctx.now - p1At > this.params.MP1B_EVENT_FRESH_MS) return noEntry('P1 首次入场窗口已过');
    if (ctx.now - evAt > this.params.MP1B_EVENT_FRESH_MS) return noEntry('异动证据已过期');
    if (same && st?.round) {
      if (st.lastExitAt == null) return noEntry('该事件上一轮没有平仓记录');
      if (st.lastEntryEvidenceAt != null && evAt <= st.lastEntryEvidenceAt) return noEntry('等待开仓后出现新的事件证据');
      if (evAt <= st.lastExitAt) return noEntry('再入场证据必须晚于上次平仓');
    }

    const c1 = absPct(e.chg1m), c5 = absPct(e.chg5m);
    if (c1 != null && c1 > this.params.MP1B_MAX_CHASE_1M_PCT) return noEntry(`1m 已延伸 ${c1.toFixed(2)}%，拒绝追单`);
    if (c5 != null && c5 > this.params.MP1B_MAX_CHASE_5M_PCT) return noEntry(`5m 已延伸 ${c5.toFixed(2)}%，拒绝追单`);

    let side: 'LONG' | 'SHORT', modeTag: string, riskMultiplier: number;
    if (e.breakout.status === 'FALSE') {
      const base = e.breakout.baseline;
      if (!(base != null && base > 0)) return noEntry('假突破缺少基准价，不猜测反转');
      const reversal = e.dir === 'UP' ? (base - ctx.mark) / base * 100 : (ctx.mark - base) / base * 100;
      if (reversal < this.params.MP1B_FALSE_BREAKOUT_REENTRY_PCT) return noEntry('假突破尚未越过反向确认距离');
      side = e.dir === 'UP' ? 'SHORT' : 'LONG';
      modeTag = 'FALSE_BREAKOUT_REVERSAL';
      riskMultiplier = this.params.MP1B_FALSE_BREAKOUT_RISK_MULTIPLIER;
    } else if (e.breakout.status === 'CONFIRMED') {
      side = e.dir === 'UP' ? 'LONG' : 'SHORT';
      modeTag = 'BREAKOUT_CONFIRMED';
      riskMultiplier = 1;
    } else if (e.breakout.status === 'REVIEW') {
      return noEntry('突破状态待复核，不自动猜方向');
    } else {
      const pending = e.evidence.some(x => x.kind === 'BREAKOUT_UP_PENDING' || x.kind === 'BREAKOUT_DOWN_PENDING');
      const spike = e.evidence.some(x => x.kind === (e.dir === 'UP' ? 'SPIKE_UP' : 'SPIKE_DOWN'));
      if (pending) {
        side = e.dir === 'UP' ? 'LONG' : 'SHORT';
        modeTag = 'BREAKOUT_PENDING';
        riskMultiplier = this.params.MP1B_PENDING_BREAKOUT_RISK_MULTIPLIER;
      } else if (spike) {
        side = e.dir === 'UP' ? 'LONG' : 'SHORT';
        modeTag = 'MOMENTUM_ACCELERATION';
        riskMultiplier = this.params.MP1B_ACCELERATION_RISK_MULTIPLIER;
      } else return noEntry('MAJOR P1 事件无明确突破或方向性脉冲证据');
    }
    this.candidates.set(e.symbol, { cycleId, evidenceAt: evAt });
    return {
      want: true, side, modeTag, cycleId, evidenceAt: evAt, riskMultiplier,
      reason: `MAJOR P1 ${e.dir}; mode=${modeTag}; breakout=${e.breakout.status}; 1m=${e.chg1m ?? 'NA'}%; 5m=${e.chg5m ?? 'NA'}%; volume×${e.volumeMultiple ?? 'NA'}`,
    };
  }

  evaluateExit(input: { meta: TrendTradeMetaRow; pos: { entryPrice: number; qty: number; margin: number; side: 'LONG' | 'SHORT'; openedAt: number }; mark: number; signal: UnifiedTrendSignal | null; now: number }): StrategyExitVerdict {
    const { meta, pos, mark, now } = input;
    if (!(mark > 0 && pos.entryPrice > 0 && pos.qty > 0 && pos.margin > 0)) return { exit: false, reason: null, detail: '' };
    const sign = pos.side === 'LONG' ? 1 : -1;
    const favorable = (mark - pos.entryPrice) / pos.entryPrice * 100 * sign;
    const adverse = Math.max(0, -favorable);
    if (adverse >= this.params.MP1B_STOP_LOSS_PCT) {
      return { exit: true, reason: 'STOP_LOSS', detail: `MAJOR P1 硬止损：价格逆向 ${adverse.toFixed(2)}% ≥ ${this.params.MP1B_STOP_LOSS_PCT}%` };
    }

    const snapshot = this.readEventSnapshot(meta.signalAtOpen), base = snapshot?.breakout?.baseline;
    if (base != null && base > 0) {
      const breached = pos.side === 'LONG'
        ? mark <= base * (1 - this.params.MP1B_STRUCTURE_INVALIDATION_PCT / 100)
        : mark >= base * (1 + this.params.MP1B_STRUCTURE_INVALIDATION_PCT / 100);
      const prev = this.states.get(meta.symbol);
      const s: State = prev?.cycleId === meta.trendCycleId ? { ...prev } : {
        cycleId: meta.trendCycleId, round: meta.entryRound ?? 1,
        lastEntryEvidenceAt: null, lastEntryAt: null, lastExitAt: null, lastExitReason: null, structureBreachCount: 0,
      };
      const n = breached ? s.structureBreachCount + 1 : 0;
      if (n !== s.structureBreachCount) { s.structureBreachCount = n; this.states.set(meta.symbol, s); this.flush(meta.symbol); }
      if (n >= this.params.MP1B_STRUCTURE_BREACH_TICKS) {
        return { exit: true, reason: 'BREAKOUT_FAILED', detail: `突破结构失效：价格连续 ${n} 次越过基准线缓冲区，baseline=${base}` };
      }
    }

    const liveMarginPnl = (mark - pos.entryPrice) * pos.qty * sign / pos.margin * 100;
    const peakMarginPnl = Math.max(meta.mfe ?? liveMarginPnl, liveMarginPnl);
    const peakPriceMove = peakMarginPnl * pos.margin / (pos.entryPrice * pos.qty);
    const giveback = peakPriceMove - favorable;
    if (now - pos.openedAt >= this.params.MP1B_MAX_HOLD_WITHOUT_EXPANSION_MS && peakPriceMove < this.params.MP1B_TRAIL_ARM_PCT) {
      return { exit: true, reason: 'EVENT_TIMEOUT', detail: '重大异动持仓超时但未出现足够顺向扩张，退出释放资金' };
    }
    if (peakPriceMove >= this.params.MP1B_TRAIL_ARM_PCT && giveback >= this.params.MP1B_TRAIL_GIVEBACK_PCT) {
      return { exit: true, reason: 'TRAIL_TAKE', detail: `移动止盈：峰值顺向价格幅度 ${peakPriceMove.toFixed(2)}%，回撤 ${giveback.toFixed(2)}%` };
    }
    return { exit: false, reason: null, detail: '' };
  }

  nextRound(symbol: string, cycleId: string): number {
    const s = this.states.get(symbol);
    return !s || !cycleId || s.cycleId !== cycleId ? 1 : s.round + 1;
  }
  onOpen(symbol: string, cycleId: string, _bar: number | null, now: number): void {
    const prev = this.states.get(symbol), c = this.candidates.get(symbol);
    const s: State = prev?.cycleId === cycleId ? { ...prev, round: prev.round + 1 } : {
      cycleId, round: 1, lastEntryEvidenceAt: null, lastEntryAt: null, lastExitAt: null, lastExitReason: null, structureBreachCount: 0,
    };
    s.lastEntryAt = now;
    if (c?.cycleId === cycleId) s.lastEntryEvidenceAt = c.evidenceAt;
    s.structureBreachCount = 0;
    this.states.set(symbol, s); this.candidates.delete(symbol); this.flush(symbol);
  }
  onClose(symbol: string, cycleId: string, reason: string, now: number): void {
    const s = this.states.get(symbol);
    if (!s || s.cycleId !== cycleId) return;
    this.states.set(symbol, { ...s, lastExitAt: now, lastExitReason: reason, structureBreachCount: 0 });
    this.flush(symbol);
  }
  exportState(): Record<string, unknown> {
    return Object.fromEntries(this.states.entries());
  }
  importState(raw: unknown): void {
    this.states.clear(); this.candidates.clear();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [symbol, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Partial<State>;
      if (typeof v.cycleId !== 'string' || typeof v.round !== 'number') continue;
      this.states.set(symbol, {
        cycleId: v.cycleId, round: v.round,
        lastEntryEvidenceAt: typeof v.lastEntryEvidenceAt === 'number' ? v.lastEntryEvidenceAt : null,
        lastEntryAt: typeof v.lastEntryAt === 'number' ? v.lastEntryAt : null,
        lastExitAt: typeof v.lastExitAt === 'number' ? v.lastExitAt : null,
        lastExitReason: typeof v.lastExitReason === 'string' ? v.lastExitReason : null,
        structureBreachCount: typeof v.structureBreachCount === 'number' ? Math.max(0, Math.floor(v.structureBreachCount)) : 0,
      });
    }
  }
  private readEventSnapshot(raw: string): EnhancedEventDTO | null {
    try { return (JSON.parse(raw) as { eventSnapshot?: EnhancedEventDTO }).eventSnapshot ?? null; }
    catch { return null; }
  }
  private flush(symbol: string): void {
    if (!this.onStateChange) return;
    try { this.onStateChange(this.id, symbol, JSON.stringify(this.states.get(symbol) ?? {})); }
    catch { /* 状态落库失败不能阻断交易循环。 */ }
  }
}
