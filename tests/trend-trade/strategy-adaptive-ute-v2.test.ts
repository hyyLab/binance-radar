// ---------- 自适应 UTE v2 单元测试（纯内存，不触碰 DB） ----------
import { describe, expect, test } from 'bun:test';
import { AdaptiveUteV2Strategy } from '@/lib/market/trend-trade/strategy/adaptive-ute-v2';
import { createStrategy, listStrategies } from '@/lib/market/trend-trade/strategy/registry';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';
import type { TrendTradeMetaRow } from '@/lib/market/trend-trade/repo';
import type { StrategyMarketCtx } from '@/lib/market/trend-trade/strategy/types';

let bar = Date.now() - 600_000;

function signal(p: {
  direction?: 'up' | 'down';
  score?: number;
  consistency?: number;
  volumeRatio?: number;
  er?: number;
  wick?: number;
  rawBreakout?: 'up' | 'down' | 'none';
  structuralBreakout?: 'up' | 'down' | 'none';
  falseBreakout?: boolean;
  rangeExpansion?: number;
  volRegime?: 'NORMAL' | 'HIGH' | 'EXTREME';
  volPercentile?: number;
  htf5?: 'up' | 'down' | 'flat';
  htf5Ret?: number;
  htf15?: 'up' | 'down' | 'flat';
  confirmCount?: number;
  strength?: number;
  cycleId?: string;
} = {}): UnifiedTrendSignal {
  bar += 60_000;
  const direction = p.direction ?? 'down';
  return {
    symbol: 'ZEREBROUSDT',
    market: 'futures',
    interval: '1m',
    phase: direction === 'down' ? 'CONFIRMED_DOWN' : 'CONFIRMED_UP',
    direction,
    trendCycleId: p.cycleId ?? `ZEREBROUSDT:${direction === 'down' ? 'S' : 'L'}:${bar}`,
    trendStartedAt: bar - 180_000,
    endPendingSince: null,
    endEvidenceBars: 0,
    endedAt: null,
    endReason: null,
    score: p.score ?? 68,
    strength: p.strength ?? 0.6,
    confirmCount: p.confirmCount ?? 4,
    uteEvidence: {
      returnPct: direction === 'down' ? -1.2 : 1.2,
      directionalConsistency: p.consistency ?? 0.8,
      volumeRatio: p.volumeRatio ?? 1,
      breakout: p.rawBreakout ?? direction,
      rangeExpansion: p.rangeExpansion ?? 1,
      anomalyFlag: false,
      barsUsed: 480,
      latestBarTime: bar,
    },
    features: {
      atr: 0.01, atrPct: 0.4, realizedVolPct: 20,
      volPercentile: p.volPercentile ?? 0.5,
      volRegime: p.volRegime ?? 'NORMAL',
      efficiencyRatio: p.er ?? 0.65,
      upperWickPct: direction === 'up' ? (p.wick ?? 0.1) : 0.1,
      lowerWickPct: direction === 'down' ? (p.wick ?? 0.1) : 0.1,
      breakout: p.structuralBreakout ?? direction,
      falseBreakout: p.falseBreakout ?? false,
      barsUsed: 480,
    },
    htf5m: { dir: p.htf5 ?? direction, efficiencyRatio: 0.6, returnPct: p.htf5Ret ?? (direction === 'down' ? -1 : 1), valid: true, bars: 96 },
    htf15m: { dir: p.htf15 ?? direction, efficiencyRatio: 0.5, returnPct: direction === 'down' ? -1 : 1, valid: true, bars: 32 },
    htfAgree: true,
    lastBarTime: bar,
    lastKlineAt: bar,
    dataFresh: true,
    dataUnavailableReason: null,
    anomaly: { dir: null, level: null, priority: null, active: false, lastAt: null },
    conflict: false,
    reason: 'test signal',
    changedAt: bar,
  } as unknown as UnifiedTrendSignal;
}

function ctx(now = Date.now()): StrategyMarketCtx {
  return {
    now,
    mark: 1,
    cfg: { name: 'trend-auto-v1', mode: 'RUNNING', initialCapital: 100, marginRatio: 0.2, leverage: 20, maxPositions: 3, slippageBps: 2, peakEquity: 0 },
    equity: { balance: 100, marginUsed: 0, unrealized: 0, equity: 100, openCount: 0 },
    openSymbols: new Set<string>(),
    lastCloseAt: null,
  } as unknown as StrategyMarketCtx;
}

function meta(modeTag: string, side: 'LONG' | 'SHORT' = 'LONG'): TrendTradeMetaRow {
  return {
    positionId: 'test-pos',
    trendCycleId: 'ZEREBROUSDT:S:1',
    symbol: 'ZEREBROUSDT',
    side,
    status: 'OPEN',
    scoreAtOpen: 80,
    featuresAtOpen: JSON.stringify({ modeTag }),
    mfe: null,
    mae: null,
    entryRound: 1,
  } as unknown as TrendTradeMetaRow;
}

describe('adaptive-ute-v2 自适应 UTE 决策层', () => {
  test('A1 注册成功，UI 策略列表可见', () => {
    const strategy = createStrategy('adaptive-ute-v2');
    expect(strategy).toBeInstanceOf(AdaptiveUteV2Strategy);
    expect(strategy.name).toBe('自适应 UTE 趋势/反转');
    expect(listStrategies().some((item) => item.id === 'adaptive-ute-v2')).toBe(true);
  });

  test('A2 高分本身不会触发反向单：证据一致时仍顺 UTE 方向', () => {
    const strategy = new AdaptiveUteV2Strategy();
    const verdict = strategy.evaluateEntry(signal({ direction: 'down', score: 88, volumeRatio: 1.2, er: 0.7 }), ctx());
    expect(verdict.want).toBe(true);
    expect(verdict.side).toBe('SHORT');
    expect(verdict.modeTag).toBe('UTE_TREND_CONTINUATION');
  });

  test('A3 成熟高分末端出现扩张与量能衰减时允许较小风险的反转试探', () => {
    const strategy = new AdaptiveUteV2Strategy();
    const verdict = strategy.evaluateEntry(signal({
      direction: 'down',
      score: 78,
      strength: 0.9,
      confirmCount: 5,
      volumeRatio: 0.55,
      er: 0.2,
      rangeExpansion: 2.1,
      volRegime: 'EXTREME',
      volPercentile: 0.93,
      wick: 0.5,
    }), ctx());
    expect(verdict.want).toBe(true);
    expect(verdict.side).toBe('LONG');
    expect(verdict.modeTag).toBe('UTE_REVERSAL_FADE_LONG');
    expect(verdict.riskMultiplier).toBe(0.65);
  });

  test('A4 相对量能过低时不论顺势/反转都拒绝入场', () => {
    const strategy = new AdaptiveUteV2Strategy();
    const verdict = strategy.evaluateEntry(signal({ volumeRatio: 0.2, score: 95, wick: 0.8, htf5: 'up' }), ctx());
    expect(verdict.want).toBe(false);
    expect(verdict.reason).toContain('相对量能过低');
  });

  test('A5 反转仓不会被来源 UTE 周期的反向确认立即秒平', () => {
    const strategy = new AdaptiveUteV2Strategy();
    const fadeMeta = meta('UTE_REVERSAL_FADE_LONG', 'LONG');
    const continuationMeta = meta('UTE_TREND_CONTINUATION', 'LONG');
    const sourceSignal = signal({ direction: 'down', cycleId: fadeMeta.trendCycleId, score: 70 });
    expect(strategy.shouldCloseOnConfirmedReverse(fadeMeta, sourceSignal)).toBe(false);
    expect(strategy.shouldCloseOnConfirmedReverse(continuationMeta, sourceSignal)).toBe(true);
  });

  test('A6 反转试探使用更紧的硬止损', () => {
    const strategy = new AdaptiveUteV2Strategy();
    const verdict = strategy.evaluateExit({
      meta: meta('UTE_REVERSAL_FADE_LONG', 'LONG'),
      pos: { side: 'LONG', entryPrice: 100, qty: 1, margin: 5, openedAt: Date.now() - 60_000 },
      mark: 99.1,
      signal: null,
      now: Date.now(),
    });
    expect(verdict.exit).toBe(true);
    expect(verdict.reason).toBe('STOP_LOSS');
    expect(verdict.detail).toContain('0.85%');
  });

  test('A7 成熟高分确认处于 5m 大幅同向延伸、且出现反转影线时允许反向试探', () => {
    const strategy = new AdaptiveUteV2Strategy();
    const verdict = strategy.evaluateEntry(signal({
      direction: 'down',
      score: 82,
      strength: 0.9,
      confirmCount: 5,
      htf5Ret: -3.1,
      volumeRatio: 1,
      er: 0.55,
      rangeExpansion: 1.1,
      wick: 0.5,
    }), ctx());
    expect(verdict.want).toBe(true);
    expect(verdict.side).toBe('LONG');
    expect(verdict.modeTag).toBe('UTE_REVERSAL_FADE_LONG');
    expect(verdict.reason).toContain('5m同向延伸');
  });
});
