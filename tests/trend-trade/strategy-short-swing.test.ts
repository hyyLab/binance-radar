// ---------- 策略「短周期套利 v1」单元测试（Task 57，纯内存无 DB） ----------
// 用户思路逐条验收：
// S1 模式 A 趋势波段：1m 确认 + 5m 同向 → 想开仓（异动方向不参与判定）
// S2 模式 B 震荡选向：5m 震荡/数据不足 → 严格门槛（score/ER 不够拒）
// S3 5m 反向 → 不做逆势
// S4 相位未确认 → 方向不确定不开
// S5 冲高套利：浮盈 + 短窗顺向快速运动 → SPIKE_TAKE；浮盈为负/幅度不足/持仓过短不触发
// S6 走弱先走：END_PENDING 同周期 exit（WEAKNESS_EARLY）；异周期不误平；参数可关
// S7 轮次：同周期再入场需新收盘 K 线 + 上限（默认 1 = 只做第一波，Task 66 顺势化）+ 新周期重置
// S8 状态导出/导入（重启恢复轮次语义）
// S10 入场追入保护（Task 66）：确认瞬间短窗已顺向冲高过多 → 拒绝（脉冲末端不追）
// S11 确认新鲜窗（Task 66）：确认已走老 → 拒绝（只做方向刚走强的第一时间顺势单）

import { describe, expect, test } from 'bun:test';
import { ShortSwingStrategy, SHORT_SWING } from '@/lib/market/trend-trade/strategy/short-swing';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';
import type { TrendTradeMetaRow } from '@/lib/market/trend-trade/repo';
import type { StrategyMarketCtx } from '@/lib/market/trend-trade/strategy/types';

let clock = Date.now() - 600_000;
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
  /** 周期确认时刻（ms）；默认 = 15 秒前（新鲜，避开确认新鲜窗对历史用例的误伤） */
  startedAtMs?: number;
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
    trendStartedAt: p.startedAtMs ?? Date.now() - 15_000,
    endPendingSince: p.phase === 'END_PENDING' ? bar : null,
    endEvidenceBars: p.endEvidenceBars ?? 0,
    endedAt: null,
    endReason: null,
    score: p.score ?? 80,
    strength: 0.6,
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
    anomaly: { dir: 'UP', level: 'MAJOR', priority: 'P1', active: true, lastAt: bar }, // 异动方向向上
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
    scoreAtOpen: 80,
    featuresAtOpen: '{}',
    signalAtOpen: '{}',
    slippageEst: 0.1,
    status: 'OPEN',
    exitReason: null,
    exitSignalJson: null,
    netPnlWithSlip: null,
    openDecisionAt: Date.now() - 120_000,
    closedAt: null,
  };
}

/** 喂一串价格样本（模拟 observe 采样：每 10s 一个点） */
function feedSamples(s: ShortSwingStrategy, symbol: string, from: number, points: { dt: number; p: number }[]) {
  let t = from;
  for (const pt of points) {
    t += pt.dt;
    s.observe(symbol, pt.p, t);
  }
}

describe('ShortSwingStrategy（短周期套利 v1）', () => {
  test('S1 模式 A：1m 确认 + 5m 同向 → 想开仓（TREND_ALIGNED；异动方向不影响）', () => {
    const s = new ShortSwingStrategy();
    // 异动向上 + 1m 看空：方向只由趋势信号决定（异动只是选币）
    const v = s.evaluateEntry(sig({ phase: 'CONFIRMED_DOWN', score: 65, er: 0.4 }), ctx());
    expect(v.want).toBe(true);
    expect(v.side).toBe('SHORT');
    expect(v.modeTag).toBe('TREND_ALIGNED');
  });

  test('S1b 模式 A 门槛：score/ER 不足拒绝（趋势起点线 45：起点分不高，但杂音分更低）', () => {
    const s = new ShortSwingStrategy();
    const v1 = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 40 }), ctx());
    expect(v1.want).toBe(false);
    const v2 = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', er: 0.2 }), ctx());
    expect(v2.want).toBe(false);
  });

  test('S2 模式 B：5m 震荡 → 严格门槛（达标想开仓 RANGE_DIRECTION；不足拒绝）', () => {
    const s = new ShortSwingStrategy();
    const ok = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 75, er: 0.5, htf5mDir: 'flat' }),
      ctx(),
    );
    expect(ok.want).toBe(true);
    expect(ok.modeTag).toBe('RANGE_DIRECTION');
    const bad = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 50, er: 0.5, htf5mDir: 'flat' }),
      ctx(),
    );
    expect(bad.want).toBe(false); // < 55（模式 B 严一档）
    const bad2 = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 75, er: 0.4, htf5mValid: false }),
      ctx(),
    );
    expect(bad2.want).toBe(false); // 5m 数据不足视同震荡，同严门槛
  });

  test('S3 5m 反向 → 不做逆势（ALLOW_HTF_OPPOSED=false）', () => {
    const s = new ShortSwingStrategy();
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', htf5mDir: 'down' }),
      ctx(),
    );
    expect(v.want).toBe(false);
    expect(v.modeTag).toBe('HTF_OPPOSED');
  });

  test('S4 相位未确认 → 方向不确定不开仓', () => {
    const s = new ShortSwingStrategy();
    for (const phase of ['OBSERVING', 'CANDIDATE_UP', 'ENDED', 'END_PENDING', 'DATA_UNAVAILABLE']) {
      const v = s.evaluateEntry(sig({ phase }), ctx());
      expect(v.want).toBe(false);
    }
  });

  test('S5 冲高套利：浮盈 + 短窗拉升 ≥ 阈值 → SPIKE_TAKE', () => {
    const s = new ShortSwingStrategy();
    const now = Date.now();
    const m = meta('BTCUSDT', 'BTCUSDT:L:1');
    const pos = { entryPrice: 100, qty: 4, margin: 20, side: 'LONG' as const, openedAt: now - 120_000 };
    // 窗口内 100 → 100.9（+0.9% ≥ 0.4% 阈值），浮盈 (100.9-100)*4/20 = +18%
    feedSamples(s, 'BTCUSDT', now - 100_000, [
      { dt: 10_000, p: 100 },
      { dt: 80_000, p: 100.9 }, // 当前价
    ]);
    const v = s.evaluateExit({ meta: m, pos, mark: 100.9, signal: null, now: now + 10_000 });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('SPIKE_TAKE');
  });

  test('S5b 冲高套利不触发：浮盈为负 / 幅度不足 / 持仓过短', () => {
    const s = new ShortSwingStrategy();
    const now = Date.now();
    const m = meta('BTCUSDT', 'BTCUSDT:L:1');
    feedSamples(s, 'BTCUSDT', now - 100_000, [
      { dt: 10_000, p: 100 },
      { dt: 80_000, p: 100.9 },
    ]);
    // 浮盈为负（entry 高于现价）
    const vNeg = s.evaluateExit({
      meta: m,
      pos: { entryPrice: 101, qty: 4, margin: 20, side: 'LONG', openedAt: now - 120_000 },
      mark: 100.9, signal: null, now: now + 10_000,
    });
    expect(vNeg.exit).toBe(false);
    // 幅度不足（+0.3% < 0.4%）
    s.observe('XRPUSDT', 100, now - 90_000);
    s.observe('XRPUSDT', 100.3, now + 10_000);
    const vSmall = s.evaluateExit({
      meta: meta('XRPUSDT', 'XRPUSDT:L:2'),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: now - 120_000 },
      mark: 100.3, signal: null, now: now + 10_000,
    });
    expect(vSmall.exit).toBe(false);
    // 持仓时间不足（< SPIKE_MIN_HOLD_MS）
    const vFast = s.evaluateExit({
      meta: m,
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'LONG', openedAt: now - 10_000 },
      mark: 100.9, signal: null, now: now + 10_000,
    });
    expect(vFast.exit).toBe(false);
  });

  test('S5c SHORT 对称：短窗下杀 → SPIKE_TAKE', () => {
    const s = new ShortSwingStrategy();
    const now = Date.now();
    feedSamples(s, 'ETHUSDT', now - 100_000, [
      { dt: 10_000, p: 100 },
      { dt: 80_000, p: 99.0 }, // -1%
    ]);
    const v = s.evaluateExit({
      meta: meta('ETHUSDT', 'ETHUSDT:S:1', 'SHORT'),
      pos: { entryPrice: 100, qty: 4, margin: 20, side: 'SHORT', openedAt: now - 120_000 },
      mark: 99.0, signal: null, now: now + 10_000,
    });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('SPIKE_TAKE');
  });

  test('S6 走弱先走：同周期 END_PENDING → WEAKNESS_EARLY；异周期不误平；参数可关', () => {
    const s = new ShortSwingStrategy();
    const now = Date.now();
    const m = meta('BTCUSDT', 'BTCUSDT:L:1');
    const pos = { entryPrice: 100, qty: 4, margin: 20, side: 'LONG' as const, openedAt: now - 120_000 };
    // 同周期 END_PENDING → exit
    const v = s.evaluateExit({
      meta: m, pos, mark: 100,
      signal: sig({ phase: 'END_PENDING', cycleId: 'BTCUSDT:L:1', endEvidenceBars: 1 }),
      now,
    });
    expect(v.exit).toBe(true);
    expect(v.reason).toBe('WEAKNESS_EARLY');
    // 异周期 END_PENDING → 不动（不走 Task 56 周期归属老路）
    const vOther = s.evaluateExit({
      meta: m, pos, mark: 100,
      signal: sig({ phase: 'END_PENDING', cycleId: 'BTCUSDT:L:999' }),
      now,
    });
    expect(vOther.exit).toBe(false);
    // 参数关闭（等 ENDED 基础设施规则）→ 不由策略平
    const s2 = new ShortSwingStrategy({ WEAKNESS_EXIT_EARLY: false });
    const vOff = s2.evaluateExit({
      meta: m, pos, mark: 100,
      signal: sig({ phase: 'END_PENDING', cycleId: 'BTCUSDT:L:1' }),
      now,
    });
    expect(vOff.exit).toBe(false);
  });

  test('S7 轮次机制：首次=1；同周期平仓后需新 K 线再入场；上限 2（注入）；新周期重置', () => {
    const s = new ShortSwingStrategy({ MAX_ROUNDS_PER_CYCLE: 2 }); // 注入 2 轮以测试上限机制
    const cyc = 'BTCUSDT:L:100';
    expect(s.nextRound('BTCUSDT', cyc)).toBe(1);
    // 首开 → round 1
    s.onOpen('BTCUSDT', cyc, 1000, Date.now());
    expect(s.nextRound('BTCUSDT', cyc)).toBe(2);
    // 平仓（走弱离场；时间回拨避开再入场间隔检查——间隔单独在 S7b 验证）
    s.onClose('BTCUSDT', cyc, 'WEAKNESS_EARLY', Date.now() - 120_000);
    // 同周期信号（旧 bar）→ 拒绝（无新证据）
    const oldBar = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: cyc, lastBarTime: 1000 }), ctx());
    expect(oldBar.want).toBe(false);
    // 新收盘 K 线 → 想再入场（#R2）
    const reentry = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: cyc, lastBarTime: 2000 }), ctx());
    expect(reentry.want).toBe(true);
    s.onOpen('BTCUSDT', cyc, 2000, Date.now());
    expect(s.nextRound('BTCUSDT', cyc)).toBe(3);
    // 再平仓后 → 轮次用尽（MAX_ROUNDS_PER_CYCLE=2）拒绝
    s.onClose('BTCUSDT', cyc, 'SPIKE_TAKE', Date.now() - 120_000);
    const exhausted = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', cycleId: cyc, lastBarTime: 3000 }),
      ctx(),
    );
    expect(exhausted.want).toBe(false);
    // 新周期 → 从 1 重新开始
    const fresh = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:999' }), ctx());
    expect(fresh.want).toBe(true);
    expect(s.nextRound('BTCUSDT', 'BTCUSDT:L:999')).toBe(1);
  });

  test('S7b 同周期再入场最小间隔（刚平仓不立即重进）', () => {
    const s = new ShortSwingStrategy();
    const cyc = 'BTCUSDT:L:100';
    s.onOpen('BTCUSDT', cyc, 1000, Date.now() - 60_000);
    s.onClose('BTCUSDT', cyc, 'SPIKE_TAKE', Date.now()); // 刚平仓
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', cycleId: cyc, lastBarTime: 5000 }),
      ctx(),
    );
    expect(v.want).toBe(false); // REENTRY_MIN_GAP_MS 未满足
  });

  test('S8 状态导出/导入（重启恢复轮次语义）', () => {
    const s = new ShortSwingStrategy();
    s.onOpen('BTCUSDT', 'BTCUSDT:L:100', 1000, Date.now());
    s.onClose('BTCUSDT', 'BTCUSDT:L:100', 'SPIKE_TAKE', Date.now());
    s.onOpen('BTCUSDT', 'BTCUSDT:L:100', 2000, Date.now()); // #R2
    const dumped = s.exportState();
    const s2 = new ShortSwingStrategy();
    s2.importState(dumped);
    expect(s2.nextRound('BTCUSDT', 'BTCUSDT:L:100')).toBe(3);
    // 损坏 JSON 安全跳过
    s2.importState({ BAD: { cycleId: 123 }, OK: { cycleId: 'X:L:1', round: 1 } });
    expect(s2.nextRound('OK', 'X:L:1')).toBe(2);
  });

  test('S7c 默认轮次=1（Task 66 顺势化）：同周期走弱离场后不再进（有新 K 线也不进）', () => {
    const s = new ShortSwingStrategy(); // 默认 MAX_ROUNDS_PER_CYCLE=1
    const cyc = 'BTCUSDT:L:100';
    const v1 = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: cyc }), ctx());
    expect(v1.want).toBe(true);
    s.onOpen('BTCUSDT', cyc, 1000, Date.now());
    s.onClose('BTCUSDT', cyc, 'WEAKNESS_EARLY', Date.now() - 120_000); // 时间回拨避开间隔检查
    const v2 = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', cycleId: cyc, lastBarTime: 5000 }), // 有新收盘 K 线
      ctx(),
    );
    expect(v2.want).toBe(false);
    expect(v2.reason).toContain('轮次已用尽');
  });

  test('S10 入场追入保护（Task 66）：确认瞬间短窗已顺向冲高 ≥1.2% → 拒绝（脉冲末端不追）', () => {
    const s = new ShortSwingStrategy();
    const now = Date.now();
    // 短窗内 100 → 101.5（+1.5% ≥ ENTRY_CHASE_PCT 1.2%）
    feedSamples(s, 'BTCUSDT', now - 100_000, [
      { dt: 10_000, p: 100 },
      { dt: 80_000, p: 101.5 },
    ]);
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 80, er: 0.5 }),
      ctx(101.5, now + 10_000),
    );
    expect(v.want).toBe(false);
    expect(v.modeTag).toBe('CHASE_GUARD');
    // 对称：SHORT 方向看跌幅——下杀 1.5% 的短窗不挡 CONFIRMED_DOWN 入场
    const vs = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_DOWN', score: 80, er: 0.5 }),
      ctx(101.5, now + 10_000),
    );
    expect(vs.want).toBe(true); // 顺向运动对 SHORT 是逆势方向：不构成追入
  });

  test('S10b 追入保护不误伤：顺向运动不足阈值 → 正常放行', () => {
    const s = new ShortSwingStrategy();
    const now = Date.now();
    feedSamples(s, 'BTCUSDT', now - 100_000, [
      { dt: 10_000, p: 100 },
      { dt: 80_000, p: 100.5 }, // +0.5% < 1.2%
    ]);
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 80, er: 0.5 }),
      ctx(100.5, now + 10_000),
    );
    expect(v.want).toBe(true);
    expect(v.modeTag).toBe('TREND_ALIGNED');
  });

  test('S11 确认新鲜窗（Task 66）：确认已走老 → 拒绝（只做方向刚走强的第一时间顺势单）', () => {
    const s = new ShortSwingStrategy();
    // 确认发生在 6 分钟前 > ENTRY_FRESH_MS(180s)
    const v = s.evaluateEntry(
      sig({ phase: 'CONFIRMED_UP', score: 80, er: 0.5, startedAtMs: Date.now() - 360_000 }),
      ctx(),
    );
    expect(v.want).toBe(false);
    expect(v.modeTag).toBe('STALE_CONFIRM');
    // 新鲜确认（默认 fixture 15 秒前）→ 放行
    const vFresh = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 80, er: 0.5 }), ctx());
    expect(vFresh.want).toBe(true);
  });

  test('S9 默认参数未校准声明：关键阈值与文档一致（Task 66 顺势化后）', () => {
    expect(SHORT_SWING.ENTRY_MIN_SCORE).toBe(45);
    expect(SHORT_SWING.NEUTRAL_MIN_SCORE).toBe(55);
    expect(SHORT_SWING.MAX_ROUNDS_PER_CYCLE).toBe(1); // Task 66：只做第一波
    expect(SHORT_SWING.SPIKE_MOVE_PCT).toBe(0.4); // Task 66：够得着的落袋线
    expect(SHORT_SWING.ENTRY_CHASE_PCT).toBe(1.2); // Task 66：脉冲末端不追
    expect(SHORT_SWING.ENTRY_FRESH_MS).toBe(180_000); // Task 66：确认新鲜窗
    expect(SHORT_SWING.WEAKNESS_EXIT_EARLY).toBe(true);
  });
});
