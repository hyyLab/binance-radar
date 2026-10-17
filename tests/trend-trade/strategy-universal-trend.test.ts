// ---------- 策略「通用趋势引擎 v1」单元测试（Task 62，纯内存无 DB） ----------
// 验收要点 = UTE 直通车的身份特征（与短周期套利的差异即用例）：
// U1 相位未确认 → 不开（确认状态机是入场第一凭证）
// U2 纯确认制（评分门槛 0）：低分确认也入场（Task 66：还需方向选择证据，fixture 以 breakout='up' 提供）
// U3 5m 背景反向照样入场（UTE 单一标的自足、不做背景过滤——与 short-swing 本质区别）
// U4 评分下限可调（构造器覆盖生效；调高后挡弱证据）+ 默认参数快照防漂移
// U5 轮次：同周期上限 2 / 再入场需新收盘 K 线 + 最小间隔 / 新周期重置
// U6 走弱先走（机制保留，注入 WEAKNESS_EXIT_EARLY=true 验证）：END_PENDING 证据 ≥2 根才走；1 根不割；异周期不误平
// U7 无冲高落袋：浮盈未回撤不触发策略性离场（SPIKE_TAKE 是 short-swing 专属）
// UE1 方向选择确认制（Task 66）：突破同向 / ER 单边延续放行；两者皆无 = 震荡内噪声确认拒绝
// UE2 硬止损（Task 68 长周期定版 1.5%）：价格逆行 ≥1.5% → STOP_LOSS；未达线不触发
// UE3 移动止盈（Task 68 长周期定版 30/20）：峰值浮盈 ≥30% 激活后回撤 ≥20% → TRAIL_TAKE；未达线不触发
// UE4 长周期默认（Task 68）：WEAKNESS_EXIT_EARLY 默认 false——走弱不离场，持有到 ENDED/反向（U6b）
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
  /** 区间突破标记（features.breakout）；默认 'none' */
  breakout?: 'up' | 'down' | 'none';
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
      efficiencyRatio: p.er ?? 0.5, upperWickPct: 0.1, lowerWickPct: 0.1, breakout: p.breakout ?? 'none',
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

  test('U2 评分门槛 0：低分确认 + 有方向选择证据也入场（UTE 与 short-swing 的核心差异）', () => {
    const s = new UniversalTrendStrategy();
    // score 30 / ER 0.2 在 short-swing 模式 A（≥45 / ≥0.35）会被拒；UTE 评分门槛 0，
    // 方向选择证据由 breakout='up'（区间突破）提供
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 30, er: 0.2, breakout: 'up' }),
      ctx(),
    );
    expect(v.want).toBe(true);
    expect(v.side).toBe('LONG');
    expect(v.modeTag).toBe('UTE_CONFIRMED');
    const v2 = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_DOWN', score: 35, breakout: 'down' }),
      ctx(),
    );
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

  test('U4b 默认参数快照（防止无意漂移；Task 66 复盘定版）', () => {
    expect(UNIVERSAL_TREND.ENTRY_MIN_SCORE).toBe(0);
    expect(UNIVERSAL_TREND.REQUIRE_DIRECTION_PICK).toBe(true); // 方向选择确认制
    expect(UNIVERSAL_TREND.ENTRY_MIN_ER).toBe(0.3);
    expect(UNIVERSAL_TREND.MAX_ROUNDS_PER_CYCLE).toBe(2);
    expect(UNIVERSAL_TREND.STOP_LOSS_PCT).toBe(1.5); // Task 68：止损住在生命周期容忍带（0.875%）之外
    expect(UNIVERSAL_TREND.TRAIL_ARM_PCT).toBe(30); // Task 68：1.5% 价格兑现过大段才启动保护
    expect(UNIVERSAL_TREND.TRAIL_GIVEBACK_PCT).toBe(20); // Task 68：1% 价格回吐落袋 > 容忍带
    expect(UNIVERSAL_TREND.WEAKNESS_MIN_EVIDENCE_BARS).toBe(2); // 保留（开关重开时生效）
    expect(UNIVERSAL_TREND.WEAKNESS_EXIT_EARLY).toBe(false); // Task 68 长周期：走弱不离场
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
  test('U6 走弱先走（机制保留，注入开启）：END_PENDING 证据 ≥2 根才走；1 根噪声不割；异周期不误平', () => {
    const s = new UniversalTrendStrategy({ WEAKNESS_EXIT_EARLY: true }); // Task 68 默认 false（长周期），注入开启验证机制
    const cycle = 'BTCUSDT:L:100';
    // 1 根证据（单根噪声/普通回调）→ 不走（Task 66：修复「稍微回调一点就止损」）
    const v1 = s.evaluateExit({
      meta: meta('BTCUSDT', cycle),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99.5, // 逆行 0.5% < 止损线 1.5%：隔离走弱维度（止损有 UE2 专测）
      signal: sig({ phase: 'END_PENDING', cycleId: cycle, endEvidenceBars: 1 }),
      now: Date.now(),
    });
    expect(v1.exit).toBe(false);
    // 2 根证据（连续两根独立收盘 K 线持续走弱）→ 先走（仍早于 ENDED 的 3 根确认）
    const v2 = s.evaluateExit({
      meta: meta('BTCUSDT', cycle),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99.5, // 不触发硬止损（UE2 专测止损），专注走弱证据维度
      signal: sig({ phase: 'END_PENDING', cycleId: cycle, endEvidenceBars: 2 }),
      now: Date.now(),
    });
    expect(v2.exit).toBe(true);
    expect(v2.reason).toBe('WEAKNESS_EARLY');

    const other = s.evaluateExit({
      meta: meta('BTCUSDT', 'BTCUSDT:L:100'),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99.5,
      signal: sig({ phase: 'END_PENDING', cycleId: 'BTCUSDT:L:999', endEvidenceBars: 3 }),
      now: Date.now(),
    });
    expect(other.exit).toBe(false); // 异周期走弱与本持仓无关
  });

  test('U6b 长周期默认（Task 68）：WEAKNESS_EXIT_EARLY=false——END_PENDING 不离场（持有到基础设施 ENDED/反向）', () => {
    const s = new UniversalTrendStrategy(); // 默认即长周期版
    const cycle = 'BTCUSDT:L:100';
    const v = s.evaluateExit({
      meta: meta('BTCUSDT', cycle),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: Date.now() - 120_000 },
      mark: 99.5, // 不触发硬止损（UE2 专测止损），专注走弱证据维度
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

describe('通用趋势引擎 v1 · Task 66 复盘定版（方向选择确认制 + 三层离场）', () => {
  test('UE1 方向选择确认制：突破同向 / ER 单边延续放行；两者皆无 = 震荡内噪声确认拒绝', () => {
    const s = new UniversalTrendStrategy();
    // a) 突破证据：breakout='up' 与 CONFIRMED_UP 一致（字面意义的「震荡之后的方向选择」），
    //    即使 ER 低（0.1，震荡结构）也放行
    const byBo = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', er: 0.1, breakout: 'up' }), ctx());
    expect(byBo.want).toBe(true);
    expect(byBo.reason).toContain('区间突破');
    // b) 延续证据：ER 0.5 ≥ 0.3（突破后 1-2 根的单边延续段，breakout 已回落）
    const byEr = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', er: 0.5, breakout: 'none' }), ctx());
    expect(byEr.want).toBe(true);
    expect(byEr.reason).toContain('单边延续');
    // c) 两者皆无：breakout='none' + ER 0.1 → 震荡区间内的噪声确认（预判性入场），拒绝
    const noise = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', er: 0.1, breakout: 'none' }), ctx());
    expect(noise.want).toBe(false);
    expect(noise.modeTag).toBe('NO_DIRECTION_PICK');
    expect(noise.reason).toContain('方向选择');
    // d) 突破反向：CONFIRMED_UP 但 breakout='down'（向上确认与向下突破矛盾）+ ER 低 → 拒绝
    const contra = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', er: 0.1, breakout: 'down' }), ctx());
    expect(contra.want).toBe(false);
    // e) 可关：REQUIRE_DIRECTION_PICK=false 回到旧版纯确认制
    const off = new UniversalTrendStrategy({ REQUIRE_DIRECTION_PICK: false });
    const legacy = off.evaluateEntry(sig({ phase: 'CONFIRMED_UP', er: 0.1, breakout: 'none' }), ctx());
    expect(legacy.want).toBe(true);
  });

  test('UE2 硬止损：价格逆行 ≥1.5%（Task 68 长周期定版，价格口径）→ STOP_LOSS；未达线不触发', () => {
    const s = new UniversalTrendStrategy();
    const cycle = 'BTCUSDT:L:100';
    const base = {
      meta: meta('BTCUSDT', cycle),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG' as const, openedAt: Date.now() - 300_000 },
      signal: sig({ phase: 'CONFIRMED_UP', cycleId: cycle }),
    };
    // 逆行 1.8% ≥ 1.5% → 止损（20x 下 = 36% 保证金回撤即砍，不拖到强平）
    const loss = s.evaluateExit({ ...base, mark: 98.2, now: Date.now() });
    expect(loss.exit).toBe(true);
    expect(loss.reason).toBe('STOP_LOSS');
    // 逆行 1.2% < 1.5%（介于生命周期容忍带 0.875% 与止损线之间）→ 不止损（给趋势呼吸空间）
    const ok = s.evaluateExit({ ...base, mark: 98.8, now: Date.now() });
    expect(ok.exit).toBe(false);
    // SHORT 对称：entry 100 逆行到 101.8（+1.8%）→ 止损
    const shortLoss = s.evaluateExit({
      meta: meta('ETHUSDT', 'ETHUSDT:S:1', 'SHORT'),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'SHORT', openedAt: Date.now() - 300_000 },
      mark: 101.8, signal: null, now: Date.now(),
    });
    expect(shortLoss.exit).toBe(true);
    expect(shortLoss.reason).toBe('STOP_LOSS');
  });

  test('UE3 移动止盈：峰值浮盈 ≥30% 激活后回撤 ≥20% → TRAIL_TAKE；未达线不触发（Task 68 长周期 30/20）', () => {
    const s = new UniversalTrendStrategy();
    const cycle = 'BTCUSDT:L:100';
    // 持仓期峰值 MFE=40%（保证金口径 = 2% 价格 @20x）→ 已激活
    const m = { ...meta('BTCUSDT', cycle), mfe: 40 } as unknown as TrendTradeMetaRow;
    const pos = { entryPrice: 100, qty: 4, margin: 20, side: 'LONG' as const, openedAt: Date.now() - 600_000 };
    // 当前浮盈 18%：回撤 40-18=22 ≥ 20 → 落袋（保住 ≥18% 利润）
    const take = s.evaluateExit({
      meta: m, pos, mark: 100.9,
      signal: sig({ phase: 'CONFIRMED_UP', cycleId: cycle }),
      now: Date.now(),
    });
    expect(take.exit).toBe(true);
    expect(take.reason).toBe('TRAIL_TAKE');
    // 当前浮盈 32%：回撤 8 < 20 → 继续拿（趋势内正常回调不打断长周期持仓）
    const hold = s.evaluateExit({
      meta: m, pos, mark: 101.6,
      signal: sig({ phase: 'CONFIRMED_UP', cycleId: cycle }),
      now: Date.now(),
    });
    expect(hold.exit).toBe(false);
    // 未激活：MFE 只有 10%（< 30% 激活线）→ 即便当前回撤大也不触发（没有利润可保护）
    const m2 = { ...meta('BTCUSDT', cycle), mfe: 10 } as unknown as TrendTradeMetaRow;
    const notArmed = s.evaluateExit({
      meta: m2, pos, mark: 100.2,
      signal: sig({ phase: 'CONFIRMED_UP', cycleId: cycle }),
      now: Date.now(),
    });
    expect(notArmed.exit).toBe(false);
    // 实时创新高：meta.mfe 缺失（旧数据/同 tick）时用实时浮盈当峰值
    const m3 = { ...meta('BTCUSDT', cycle), mfe: null } as unknown as TrendTradeMetaRow;
    const live = s.evaluateExit({
      meta: m3, pos, mark: 102, // 实时浮盈 40%（已激活）
      signal: sig({ phase: 'CONFIRMED_UP', cycleId: cycle }),
      now: Date.now(),
    });
    expect(live.exit).toBe(false); // 峰值=实时=40%，回撤 0 → 不触发
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

  test('CP2 short-swing-v1：13 策略参数（Task 66 新增 ENTRY_CHASE_PCT/ENTRY_FRESH_MS）+ 3 infra', () => {
    const items = effectiveRuntimeParams('short-swing-v1', null, INFRA);
    expect(items.filter((p) => p.scope === 'strategy').length).toBe(13);
    expect(items.filter((p) => p.scope === 'infra').length).toBe(3);
    // 新参数确实出现在 short-swing 控制台且不属于 UTE
    const keys = items.filter((p) => p.scope === 'strategy').map((p) => p.key);
    expect(keys).toContain('ENTRY_CHASE_PCT');
    expect(keys).toContain('ENTRY_FRESH_MS');
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
