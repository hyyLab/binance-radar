// ---------- 趋势生命周期状态机 v2 + 指标 · 行为测试（Task 54 §2.2/§2.3） ----------
// 覆盖：END_PENDING 证据计数（同根去重/中断清零）、反向确认立即结束、
//       深回撤容忍带、DATA_UNAVAILABLE 冻结、指标计算与高周期聚合数据量。

import { describe, expect, test } from 'bun:test';
import { createLifecycleState, stepLifecycle } from '@/lib/market/trend-watch/lifecycle';
import { aggregateBars, computeVolatilityFeatures, DEFAULT_INDICATOR_CFG, HTF_MIN_BARS } from '@/lib/market/trend-watch/indicators';
import type { Bar } from 'universal-trend-engine';

const SYM = 'TESTUSDT';

function input(partial: {
  utePhase?: 'idle' | 'candidate' | 'confirmed';
  uteDirection?: 'up' | 'down' | 'flat';
  uteCandidateDirection?: 'up' | 'down' | 'flat';
  returnPct?: number;
  barTime?: number | null;
  uteChangedAt?: number | null;
  uteConfirmCount?: number;
  consistency?: number;
  er?: number;
  dataOk?: boolean;
  now?: number;
}) {
  return {
    utePhase: partial.utePhase ?? 'idle',
    uteDirection: partial.uteDirection ?? 'flat',
    uteCandidateDirection: partial.uteCandidateDirection ?? 'flat',
    directionalConsistency: partial.consistency ?? 0.8,
    returnPct: partial.returnPct ?? 1,
    barTime: partial.barTime ?? 1_000,
    uteChangedAt: partial.uteChangedAt ?? null,
    uteConfirmCount: partial.uteConfirmCount ?? 0,
    uteScore: 50,
    strength: 0.5,
    features: {
      atr: 1, atrPct: 1, realizedVolPct: 40, volPercentile: 0.5, volRegime: 'HIGH',
      efficiencyRatio: partial.er ?? 0.6, upperWickPct: 0.1, lowerWickPct: 0.1,
      breakout: 'none', falseBreakout: false, barsUsed: 480,
    },
    dataOk: partial.dataOk ?? true,
    now: partial.now ?? 5_000,
  } as Parameters<typeof stepLifecycle>[1];
}

describe('趋势生命周期状态机（lifecycle.ts）', () => {
  test('确认生成 trendCycleId；ENDED 后新确认生成新周期', () => {
    let lc = createLifecycleState(SYM);
    // 3 根确认 up
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    expect(lc.phase).toBe('CONFIRMED_UP');
    expect(lc.cycleId).toBe(`${SYM}:L:100`);
    // 深回撤 → 结束
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 2_000, now: 2_100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 3_100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 4_000, now: 4_100 })).state;
    expect(lc.phase).toBe('ENDED');
    expect(lc.endReason).toBe('DECAY_CONFIRMED');
    // 新周期（反向 down 确认）→ 新 cycleId
    const r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', uteChangedAt: 5_000, now: 5_100 }));
    expect(r.state.phase).toBe('CONFIRMED_DOWN');
    expect(r.state.cycleId).toBe(`${SYM}:S:5000`);
    expect(r.state.cycleId).not.toBe(`${SYM}:L:100`);
  });

  test('同根 K 线重复扫描不推进结束证据计数（与 UTE 同纪律）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    for (let i = 0; i < 5; i++) {
      lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 2_000, now: 2_100 + i })).state;
    }
    expect(lc.endEvidenceBars).toBe(1); // 同一根 barTime 只计一次
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 3_100 })).state;
    expect(lc.endEvidenceBars).toBe(2);
  });

  test('浅回撤容忍带：|returnPct| 在容忍带内不算结束证据；中断清零', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    // minMovePct 0.35 × 2.5 = 0.875：0.9% 在容忍带内（confirmed 同向 → 已确认分支）→ 趋势持续
    let r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 0.9, barTime: 2_000, now: 2_100 }));
    expect(r.state.phase).toBe('CONFIRMED_UP');
    expect(r.state.endEvidenceBars).toBe(0);
    // 1 根深回撤证据
    r = stepLifecycle(r.state, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 0.5, barTime: 3_000, now: 3_100 }));
    expect(r.state.phase).toBe('END_PENDING');
    expect(r.state.endEvidenceBars).toBe(1);
    // 证据中断（回到容忍带）→ 恢复 CONFIRMED、清零
    r = stepLifecycle(r.state, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 1.2, barTime: 4_000, now: 4_100 }));
    expect(r.state.phase).toBe('CONFIRMED_UP');
    expect(r.state.endEvidenceBars).toBe(0);
  });

  test('反向趋势确认 → 立即 ENDED(REVERSE_CONFIRMED)', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    const r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', uteChangedAt: 400, now: 400 }));
    expect(r.state.phase).toBe('ENDED');
    expect(r.state.endReason).toBe('REVERSE_CONFIRMED');
  });

  test('数据不可用 → DATA_UNAVAILABLE 冻结（不推进证据/不误判结束）；恢复后继续', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    const frozen = stepLifecycle(lc, input({ dataOk: false, barTime: null, now: 200 }));
    expect(frozen.state.phase).toBe('DATA_UNAVAILABLE');
    expect(frozen.state.cycleId).toBe(`${SYM}:L:100`); // 底层周期冻结保留
    // 恢复：深回撤证据继续计数
    const r = stepLifecycle(frozen.state, input({ utePhase: 'idle', returnPct: 0.1, barTime: 2_000, now: 2_100 }));
    expect(r.state.endEvidenceBars).toBe(1);
  });

  test('DATA_UNAVAILABLE 期间反向确认：恢复后立即结束（不漏判）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    lc = stepLifecycle(lc, input({ dataOk: false, barTime: null, now: 200 })).state;
    const r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', uteChangedAt: 900, now: 900 }));
    expect(r.state.phase).toBe('ENDED');
    expect(r.state.endReason).toBe('REVERSE_CONFIRMED');
  });
});

// ============ 指标 ============

function genBars(n: number, drift: number, noise = 0.0005, start = 100): Bar[] {
  const out: Bar[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + drift + (i % 2 === 0 ? noise : -noise));
    out.push({ time: 1_800_000_000_000 + i * 60_000, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1000 });
    p = c;
  }
  return out;
}

describe('波动率/结构特征（indicators.ts）', () => {
  test('ATR% / 已实现波动率 / ER：单边行情 ER 高、震荡行情 ER 低', () => {
    // 480 根（与生产拉取长度一致）：RV 分位采样满 3 个窗口才可用（样本不足返回 -1 不伪造）
    const trending = computeVolatilityFeatures(genBars(480, 0.002), DEFAULT_INDICATOR_CFG);
    expect(trending.efficiencyRatio).toBeGreaterThan(0.7);
    expect(trending.atrPct).toBeGreaterThan(0);
    expect(trending.realizedVolPct).toBeGreaterThan(0);
    expect(trending.volPercentile).toBeGreaterThanOrEqual(0);

    // 真往返震荡：收盘价在 a↔b 间来回（净位移≈0，路径大 → ER≈0）
    const chop: Bar[] = [];
    const base = 100;
    for (let i = 0; i < 480; i++) {
      const o = i === 0 ? base : chop[i - 1]!.close;
      const c = i % 2 === 0 ? base * 1.003 : base;
      chop.push({ time: 1_800_000_000_000 + i * 60_000, open: o, high: Math.max(o, c) * 1.0005, low: Math.min(o, c) * 0.9995, close: c, volume: 1000 });
    }
    const chopF = computeVolatilityFeatures(chop, DEFAULT_INDICATOR_CFG);
    expect(chopF.efficiencyRatio).toBeLessThan(0.3);
    expect(chopF.efficiencyRatio).toBeLessThan(trending.efficiencyRatio);
  });

  test('1m → 15m 聚合：480 根产出 ≥16 根已收盘 15m bar（数据量达标，不冒充确认）', () => {
    const bars = genBars(480, 0.001);
    const agg = aggregateBars(bars, 15);
    expect(agg.length).toBe(32);
    expect(HTF_MIN_BARS).toBe(16);
    // 高周期 OHLCV 一致性：bucket 聚合的 high/low 覆盖全部成员
    //（Bar.time = 收盘时刻，bucket 按 floor 归属：成员 = [bucketEnd-15m, bucketEnd)）
    const first = agg[0]!;
    const members = bars.filter((b) => b.time >= first.time - 15 * 60_000 && b.time < first.time);
    expect(members.length).toBe(15);
    expect(Math.max(...members.map((m) => m.high))).toBeCloseTo(first.high, 9);
    expect(Math.min(...members.map((m) => m.low))).toBeCloseTo(first.low, 9);
    // 不足 480 根：13 个整 bucket + 1 个未走完（由 assessHtf 按收盘时刻过滤）
    expect(aggregateBars(genBars(200, 0.001), 15).length).toBe(14);
  });
});
