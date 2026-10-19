// ---------- 策略「强趋势顺随引擎 v1」单元测试(Task 81,纯内存无 DB) ----------
// 验收要点:
// S1 registry 注册:createStrategy('strong-trend-v1') 返回独立身份 + 默认 ENTRY_MIN_SCORE=70
// S2 评分门槛 70 生效:score 69 拒(含门槛文案)/ score 70 放行(方向选择证据由 breakout 提供)
// S3 控制台参数覆盖仍可用(工厂 spread 顺序:默认 70 → 覆盖参数可改)
// S4 离场层：硬止损 1.5% 价格（同源）/ 移动止盈 8/5（Task 84 用户定版，zerebro 标本镜像）
// S5 向后兼容:new UniversalTrendStrategy() 默认身份不变(id universal-trend-v1 / 评分门槛 0)
// S6 Task 84 参数断言:registry 工厂默认 TRAIL 8/5 生效，控制台仍可覆盖

import { describe, expect, test } from 'bun:test';
import {
  UniversalTrendStrategy,
  UNIVERSAL_TREND,
} from '@/lib/market/trend-trade/strategy/universal-trend';
import { createStrategy, listStrategies } from '@/lib/market/trend-trade/strategy/registry';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';
import type { TrendTradeMetaRow } from '@/lib/market/trend-trade/repo';
import type { StrategyMarketCtx } from '@/lib/market/trend-trade/strategy/types';

let bar = Date.now() - 300_000;

function sig(p: {
  symbol?: string;
  phase: string;
  direction?: 'up' | 'down' | 'flat';
  cycleId?: string;
  score?: number;
  er?: number;
  breakout?: 'up' | 'down' | 'none';
  lastBarTime?: number | null;
}): UnifiedTrendSignal {
  bar += 60_000;
  const dir =
    p.direction ?? (p.phase === 'CONFIRMED_UP' ? 'up' : p.phase === 'CONFIRMED_DOWN' ? 'down' : 'flat');
  return {
    symbol: p.symbol ?? 'BTCUSDT',
    market: 'futures',
    interval: '1m',
    phase: p.phase as UnifiedTrendSignal['phase'],
    direction: dir,
    trendCycleId: p.cycleId ?? `BTCUSDT:${dir === 'down' ? 'S' : 'L'}:${bar}`,
    trendStartedAt: bar,
    endPendingSince: p.phase === 'END_PENDING' ? bar : null,
    endEvidenceBars: 0,
    endedAt: null,
    endReason: null,
    score: p.score ?? 55,
    strength: 0.5,
    confirmCount: 3,
    features: {
      atr: 1, atrPct: 1.2, realizedVolPct: 40, volPercentile: 0.7, volRegime: 'HIGH',
      efficiencyRatio: p.er ?? 0.5, upperWickPct: 0.1, lowerWickPct: 0.1, breakout: p.breakout ?? 'none',
      falseBreakout: false, barsUsed: 480,
    },
    htf5m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 96 },
    htf15m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 32 },
    htfAgree: true,
    lastBarTime: p.lastBarTime !== undefined ? p.lastBarTime : bar,
    lastKlineAt: bar,
    dataFresh: true,
    dataUnavailableReason: null,
    anomaly: { dir: 'UP', level: 'MAJOR', priority: 'P1', active: true, lastAt: bar },
    conflict: false,
    reason: '测试信号',
    changedAt: bar,
  } as unknown as UnifiedTrendSignal;
}

function ctx(mark = 100, now = Date.now()): StrategyMarketCtx {
  return {
    now,
    mark,
    cfg: {
      name: 'trend-auto-v1', mode: 'RUNNING', initialCapital: 100, marginRatio: 0.2,
      leverage: 20, maxPositions: 3, slippageBps: 2, peakEquity: 0,
    },
    equity: { balance: 100, marginUsed: 0, unrealized: 0, equity: 100, openCount: 0 },
    openSymbols: new Set<string>(),
    lastCloseAt: null,
  } as unknown as StrategyMarketCtx;
}

function meta(p: Partial<TrendTradeMetaRow> = {}): TrendTradeMetaRow {
  return {
    positionId: 'pos-1', trendCycleId: 'BTCUSDT:L:1', symbol: 'BTCUSDT', side: 'LONG',
    status: 'OPEN', scoreAtOpen: 75, mfe: null, mae: null, entryRound: 1,
    ...p,
  } as unknown as TrendTradeMetaRow;
}

describe('strong-trend-v1 强趋势顺随引擎(Task 81)', () => {
  test('S1 registry 注册:独立身份 + 默认 ENTRY_MIN_SCORE=70', () => {
    const s = createStrategy('strong-trend-v1');
    expect(s.id).toBe('strong-trend-v1');
    expect(s.name).toBe('强趋势顺随引擎');
    expect((s as UniversalTrendStrategy).params.ENTRY_MIN_SCORE).toBe(70);
    expect(listStrategies().some((x) => x.id === 'strong-trend-v1')).toBe(true);
  });

  test('S2 评分门槛 70:score 69 拒 / score 70 放行(方向选择证据齐备)', () => {
    const s = createStrategy('strong-trend-v1');
    const rej = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 69, breakout: 'up' }), ctx());
    expect(rej.want).toBe(false);
    expect(rej.reason).toContain('评分 69 < 70');
    const ok = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 70, breakout: 'up' }), ctx());
    expect(ok.want).toBe(true);
    expect(ok.side).toBe('LONG');
    expect(ok.modeTag).toBe('UTE_CONFIRMED');
    // ER 延续路径同样放行(方向选择的另一证据形态)
    const ok2 = s.evaluateEntry(sig({ phase: 'CONFIRMED_DOWN', score: 72, er: 0.4 }), ctx());
    expect(ok2.want).toBe(true);
    expect(ok2.side).toBe('SHORT');
  });

  test('S3 控制台参数覆盖仍可用(工厂默认 70 → 覆盖生效)', () => {
    const s = createStrategy('strong-trend-v1', { ENTRY_MIN_SCORE: 60 });
    expect((s as UniversalTrendStrategy).params.ENTRY_MIN_SCORE).toBe(60);
  });

  test('S4 离场层:硬止损 1.5% 同源 / 移动止盈 8/5(zerebro 标本镜像)', () => {
    const s = createStrategy('strong-trend-v1');
    // 硬止损:模型 LONG,价格逆行 1.6% ≥ 1.5% → STOP_LOSS
    const sl = s.evaluateExit({
      meta: meta(),
      pos: { side: 'LONG', entryPrice: 100, qty: 2, margin: 10, openedAt: Date.now() - 60_000 },
      mark: 98.4,
      signal: null,
      now: Date.now(),
    });
    expect(sl.exit).toBe(true);
    expect(sl.reason).toBe('STOP_LOSS');
    // 移动止盈 8/5(Task 84,zerebro 三标本镜像:峰值 +8.1% 回吐到 +3.0% 即落袋,
    // 旧参数 30/20 下这单会一路奔向 -30% 硬止损)
    const tt = s.evaluateExit({
      meta: meta({ mfe: 8.1 }),
      pos: { side: 'LONG', entryPrice: 100, qty: 2, margin: 10, openedAt: Date.now() - 60_000 },
      mark: 100 * (1 + (0.03 * 10) / (2 * 100)), // 实时浮盈 +3%:回撤 5.1 ≥ 5
      signal: null,
      now: Date.now(),
    });
    expect(tt.exit).toBe(true);
    expect(tt.reason).toBe('TRAIL_TAKE');
    // 未武装:浮盈 +7.9% < 8% 武装线 → 无保护、不离场(等回撤线/止损/ENDED)
    const hold = s.evaluateExit({
      meta: meta(),
      pos: { side: 'LONG', entryPrice: 100, qty: 2, margin: 10, openedAt: Date.now() - 60_000 },
      mark: 100 * (1 + (0.079 * 10) / (2 * 100)),
      signal: null,
      now: Date.now(),
    });
    expect(hold.exit).toBe(false);
  });

  test('S5 向后兼容:new UniversalTrendStrategy() 默认身份/门槛不变', () => {
    const s = new UniversalTrendStrategy();
    expect(s.id).toBe('universal-trend-v1');
    expect(s.name).toBe('通用趋势引擎');
    expect(s.params.ENTRY_MIN_SCORE).toBe(UNIVERSAL_TREND.ENTRY_MIN_SCORE);
    expect(s.params.ENTRY_MIN_SCORE).toBe(0);
    // Task 84:strong-trend 的 8/5 只存在于注册表工厂,universal-trend-v1 默认 30/20 不受波及
    expect(s.params.TRAIL_ARM_PCT).toBe(UNIVERSAL_TREND.TRAIL_ARM_PCT);
    expect(s.params.TRAIL_ARM_PCT).toBe(30);
    expect(s.params.TRAIL_GIVEBACK_PCT).toBe(20);
    // 原策略低分确认 + 方向选择证据照样放行(U2 回归)
    const v = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 30, breakout: 'up' }), ctx());
    expect(v.want).toBe(true);
  });

  test('S6 Task 84 参数断言:registry 工厂默认 TRAIL 8/5,控制台覆盖仍可用', () => {
    const s = createStrategy('strong-trend-v1') as UniversalTrendStrategy;
    expect(s.params.ENTRY_MIN_SCORE).toBe(70);
    expect(s.params.TRAIL_ARM_PCT).toBe(8);
    expect(s.params.TRAIL_GIVEBACK_PCT).toBe(5);
    // 控制台热装配仍可覆盖(工厂 spread 顺序:默认 → 覆盖参数最后)
    const ov = createStrategy('strong-trend-v1', { TRAIL_ARM_PCT: 15 }) as UniversalTrendStrategy;
    expect(ov.params.TRAIL_ARM_PCT).toBe(15);
    expect(ov.params.TRAIL_GIVEBACK_PCT).toBe(5); // 未覆盖项保持工厂默认
  });
});
