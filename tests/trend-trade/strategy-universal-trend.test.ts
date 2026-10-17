// ---------- 策略「通用趋势引擎 v1」单元测试（Task 62，纯内存无 DB） ----------
// 验收要点 = UTE 直通车的身份特征（与短周期套利的差异即用例）：
// U1 相位未确认 → 不开（确认状态机是唯一入场凭证）
// U2 纯确认制：低分确认也入场（ENTRY_MIN_SCORE=0；评分/ER 不是 UTE 的门槛）
// U3 5m 背景反向照样入场（UTE 单一标的自足、不做背景过滤——与 short-swing 本质区别）
// U4 评分下限可调（构造器覆盖生效；调高后挡弱证据）+ 默认参数快照防漂移
// U5 轮次：同周期上限 2 / 再入场需新收盘 K 线 + 最小间隔 / 新周期重置
// U6 走弱先走：END_PENDING 同周期 exit（WEAKNESS_EARLY）；异周期不误平；参数可关
// U7 无冲高落袋：浮盈再大也不触发策略性离场（SPIKE_TAKE 是 short-swing 专属）
// U8 状态导出/导入（重启恢复轮次语义）
// CP1-4 console-params 按策略过滤（Task 62 机制：跨策略键拒绝/丢弃，infra 全局共享）

import { describe, expect, test } from 'bun:test';
import {
  UniversalTrendStrategy,
  UNIVERSAL_TREND,
} from '@/lib/market/trend-trade/strategy/universal-trend';
import {
  effectiveRuntimeParams,
  sanitizeRuntimeParams,
  sanitizeRuntimeParamsLenient,
} from '@/lib/market/trend-trade/console-params';
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
  htf5mDir?: 'up' | 'down' | 'flat';
  htf5mValid?: boolean;
  endEvidenceBars?: number;
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
    endEvidenceBars: p.endEvidenceBars ?? 0,
    endedAt: null,
    endReason: null,
    score: p.score ?? 55,
    strength: 0.5,
    confirmCount: 3,
    features: {
      atr: 1, atrPct: 1.2, realizedVolPct: 40, volPercentile: 0.7, volRegime: 'HIGH',
      efficiencyRatio: p.er ?? 0.5, upperWickPct: 0.1, lowerWickPct: 0.1, breakout: 'none',
      falseBreakout: false, barsUsed: 480,
    },
    htf5m: { dir: p.htf5mDir ?? dir, efficiencyRatio: 0.5, returnPct: 1, valid: p.htf5mValid ?? true, bars: 96 },
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
  } as UnifiedTrendSignal;
}

function ctx(mark = 100, now = Date.now(), openSymbols = new Set<string>()): StrategyMarketCtx {
  return {
    now,
    mark,
    cfg: {
      name: 'trend-auto-v1', mode: 'RUNNING', initialCapital: 100, marginRatio: 0.2,
      leverage: 20, maxPositions: 3, slippageBps: 2, peakEquity: 0,
    },
    equity: { balance: 100, marginUsed: 0, unrealized: 0, equity: 100, openCount: 0 },
    openSymbols,
    lastCloseAt: null,
  };
}

function meta(symbol: string, cycleId: string, side: 'LONG' | 'SHORT' = 'LONG'): TrendTradeMetaRow {
  return {
    positionId: `pos-${symbol}`,
    trendCycleId: cycleId,
    symbol,
    side,
    trendPhaseAtOpen: 'CONFIRMED_UP',
    scoreAtOpen: 55,
    featuresAtOpen: '{}',
    signalAtOpen: '{}',
    slippageEst: 0.1,
    status: 'OPEN',
    exitReason: null,
    exitSignalJson: null,
    netPnlWithSlip: null,
    openDecisionAt: Date.now() - 120_000,
    closedAt: null,
  } as unknown as TrendTradeMetaRow;
}

describe('通用趋势引擎 v1（universal-trend-v1）· 入场', () => {
  test('U1 相位未确认不开（候选/观察/结束中）', () => {
    const s = new UniversalTrendStrategy();
    for (const phase of ['OBSERVING', 'CANDIDATE_UP', 'CANDIDATE_DOWN', 'END_PENDING', 'ENDED']) {
      const v = s.evaluateEntry(sig({ phase }), ctx());
      expect(v.want).toBe(false);
    }
  });

  test('U2 纯确认制：低分确认也入场（UTE 与 short-swing 的核心差异）', () => {
    const s = new UniversalTrendStrategy();
    // score 30 / ER 0.2 在 short-swing 模式 A（≥45 / ≥0.35）会被拒；UTE 确认即顺势
    const v = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 30, er: 0.2 }), ctx());
    expect(v.want).toBe(true);
    expect(v.side).toBe('LONG');
    expect(v.modeTag).toBe('UTE_CONFIRMED');
    const v2 = s.evaluateEntry(sig({ phase: 'CONFIRMED_DOWN', score: 35 }), ctx());
    expect(v2.want).toBe(true);
    expect(v2.side).toBe('SHORT');
  });

  test('U3 5m 背景反向照样入场（UTE 不做背景过滤；reason 留档背景方向）', () => {
    const s = new UniversalTrendStrategy();
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 60, htf5mDir: 'down' }),
      ctx(),
    );
    expect(v.want).toBe(true); // short-swing 同信号是 HTF_OPPOSED 拒绝
    expect(v.reason).toContain('5m 背景 down');
  });

  test('U4 评分下限可调：调高后弱证据确认被挡（审计文案含门槛）', () => {
    const s = new UniversalTrendStrategy({ ENTRY_MIN_SCORE: 60 });
    const v = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 50 }), ctx());
    expect(v.want).toBe(false);
    expect(v.reason).toContain('评分 50 < 60');
    const ok = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 65 }), ctx());
    expect(ok.want).toBe(true);
  });

  test('U4b 默认参数快照（防止无意漂移；用户定版：控制台暂不开放，代码默认即生效）', () => {
    expect(UNIVERSAL_TREND.ENTRY_MIN_SCORE).toBe(0);
    expect(UNIVERSAL_TREND.MAX_ROUNDS_PER_CYCLE).toBe(2);
    expect(UNIVERSAL_TREND.WEAKNESS_EXIT_EARLY).toBe(true);
  });
});

describe('通用趋势引擎 v1 · 轮次与再入场', () => {
  test('U5a 同周期刚平仓 → 间隔不足拒绝（默认 60s 间隔；测试同帧执行天然 <60s）', () => {
    const s = new UniversalTrendStrategy();
    const cycle = 'BTCUSDT:L:100';
    const firstSig = sig({ phase: 'CONFIRMED_UP', cycleId: cycle });
    const first = s.evaluateEntry(firstSig, ctx());
    expect(first.want).toBe(true);
    s.onOpen('BTCUSDT', cycle, firstSig.lastBarTime ?? bar, Date.now());
    s.onClose('BTCUSDT', cycle, 'WEAKNESS_EARLY', Date.now());
    const tooSoon = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: cycle }), ctx());
    expect(tooSoon.want).toBe(false);
    expect(tooSoon.reason).toContain('间隔不足');
  });

  test('U5b 再入场：新收盘 K 线 + 间隔足 → 放行 #R2；上限 2 轮后拒绝（小间隔参数注入）', () => {
    const s = new UniversalTrendStrategy({ REENTRY_MIN_GAP_MS: 1 }); // 参数注入绕开真实等待
    const cycle = 'BTCUSDT:L:100';
    const firstSig = sig({ phase: 'CONFIRMED_UP', cycleId: cycle });
    const first = s.evaluateEntry(firstSig, ctx());
    expect(first.want).toBe(true);
    const entryBar = firstSig.lastBarTime ?? bar;
    s.onOpen('BTCUSDT', cycle, entryBar, Date.now());

    // 同 bar 回声（无新收盘 K 线）→ 不再开
    const echo = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', cycleId: cycle, lastBarTime: entryBar }),
      ctx(),
    );
    expect(echo.want).toBe(false);
    expect(echo.reason).toContain('新收盘 K 线');

    // 更新收盘 K 线出现 → #R2 放行（间隔已过）
    const fresh = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', cycleId: cycle, lastBarTime: entryBar + 60_000 }),
      ctx(),
    );
    expect(fresh.want).toBe(true);
    expect(fresh.reason).toContain('#R2');

    // 第二轮开仓平仓后再评估 → 轮次用尽（同周期第 3 轮 > 上限 2）
    s.onOpen('BTCUSDT', cycle, entryBar + 60_000, Date.now());
    s.onClose('BTCUSDT', cycle, 'WEAKNESS_EARLY', Date.now());
    const exhausted = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', cycleId: cycle, lastBarTime: entryBar + 120_000 }),
      ctx(),
    );
    expect(exhausted.want).toBe(false);
    expect(exhausted.reason).toContain('轮次已用尽');
  });

  test('U5c 新周期轮次重置为 1', () => {
    const s = new UniversalTrendStrategy();
    const c1 = 'BTCUSDT:L:100';
    s.onOpen('BTCUSDT', c1, bar, Date.now());
    s.onOpen('BTCUSDT', c1, bar, Date.now());
    expect(s.nextRound('BTCUSDT', c1)).toBe(3);
    expect(s.nextRound('BTCUSDT', 'BTCUSDT:L:999')).toBe(1); // 新周期从头计
  });
});

describe('通用趋势引擎 v1 · 离场', () => {
  test('U6 走弱先走：END_PENDING 同周期 exit；异周期不误平', () => {
    const s = new UniversalTrendStrategy();
    const cycle = 'BTCUSDT:L:100';
    const v = s.evaluateExit({
      meta: meta('BTCUSDT', cycle),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99,
      signal: sig({ phase: 'END_PENDING', cycleId: cycle, endEvidenceBars: 1 }),
      now: Date.now(),
    });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('WEAKNESS_EARLY');

    const other = s.evaluateExit({
      meta: meta('BTCUSDT', 'BTCUSDT:L:100'),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99,
      signal: sig({ phase: 'END_PENDING', cycleId: 'BTCUSDT:L:999', endEvidenceBars: 3 }),
      now: Date.now(),
    });
    expect(other.exit).toBe(false); // 异周期走弱与本持仓无关
  });

  test('U6b WEAKNESS_EXIT_EARLY=false：纯持有版，END_PENDING 不离场（等基础设施 ENDED）', () => {
    const s = new UniversalTrendStrategy({ WEAKNESS_EXIT_EARLY: false });
    const cycle = 'BTCUSDT:L:100';
    const v = s.evaluateExit({
      meta: meta('BTCUSDT', cycle),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99,
      signal: sig({ phase: 'END_PENDING', cycleId: cycle, endEvidenceBars: 2 }),
      now: Date.now(),
    });
    expect(v.exit).toBe(false);
  });

  test('U7 无冲高落袋：浮盈 + 顺向急拉也不触发策略性离场（确认在就拿满周期）', () => {
    const s = new UniversalTrendStrategy();
    const now = Date.now();
    s.observe('BTCUSDT', 100, now - 60_000); // UTE observe 为空实现，样本只是防御性喂入
    s.observe('BTCUSDT', 105, now);
    const v = s.evaluateExit({
      meta: meta('BTCUSDT', 'BTCUSDT:L:100'),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: now - 300_000 },
      mark: 105,
      signal: sig({ phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:100' }), // 确认仍在
      now,
    });
    expect(v.exit).toBe(false); // 浮盈大小不构成 UTE 离场理由（SPIKE_TAKE 属于 short-swing）
    expect(v.reason).toBeNull();
  });
});

describe('通用趋势引擎 v1 · 状态持久化', () => {
  test('U8 exportState/importState 往返（轮次语义恢复）+ 脏数据静默回空', () => {
    const s = new UniversalTrendStrategy();
    const cycle = 'BTCUSDT:L:100';
    s.onOpen('BTCUSDT', cycle, 1234, Date.now());
    s.onClose('BTCUSDT', cycle, 'WEAKNESS_EARLY', Date.now());

    const restored = new UniversalTrendStrategy();
    restored.importState(JSON.parse(JSON.stringify(s.exportState())));
    expect(restored.nextRound('BTCUSDT', cycle)).toBe(2);

    // 非法/损坏数据：静默忽略回空状态（宽松恢复，不阻断交易循环）
    const safe = new UniversalTrendStrategy();
    safe.importState({ BTCUSDT: { round: 'bad' }, ETHUSDT: 42, junk: null });
    expect(safe.nextRound('BTCUSDT', cycle)).toBe(1);
  });
});

describe('console-params 按算法过滤（Task 62 机制）', () => {
  const INFRA = { waitBarConfirm: null, cooldownMs: null, marginRatio: null };

  test('CP1 universal-trend-v1：strategy 域为空（代码默认参数），仅 infra 三项', () => {
    const items = effectiveRuntimeParams('universal-trend-v1', null, INFRA);
    expect(items.some((p) => p.scope === 'strategy')).toBe(false);
    expect(items.map((p) => p.key).sort()).toEqual(['cooldownMs', 'marginRatio', 'waitBarConfirm']);
  });

  test('CP2 short-swing-v1：行为不变（11 策略参数 + 3 infra）', () => {
    const items = effectiveRuntimeParams('short-swing-v1', null, INFRA);
    expect(items.filter((p) => p.scope === 'strategy').length).toBe(11);
    expect(items.filter((p) => p.scope === 'infra').length).toBe(3);
  });

  test('CP3 严格写路径：UTE 下提交 short-swing 键 → 明确报错（不错位存储）', () => {
    expect(() => sanitizeRuntimeParams({ ENTRY_MIN_SCORE: 50 }, 'universal-trend-v1')).toThrow(
      /不属于当前算法/,
    );
    // UTE 下 infra 键照常可调
    const ok = sanitizeRuntimeParams({ cooldownMs: 120_000 }, 'universal-trend-v1');
    expect(ok.cooldownMs).toBe(120_000);
  });

  test('CP4 宽松装配路径：UTE 下丢弃跨策略键、保留 infra 键（回退代码默认不阻断）', () => {
    const r = sanitizeRuntimeParamsLenient(
      { ENTRY_MIN_SCORE: 50, SPIKE_MOVE_PCT: 1, cooldownMs: 30_000, marginRatio: 0.3 },
      'universal-trend-v1',
    );
    expect(Object.keys(r.strategyParams).length).toBe(0);
    expect(r.cooldownMs).toBe(30_000);
    expect(r.marginRatio).toBe(0.3);
  });
});
