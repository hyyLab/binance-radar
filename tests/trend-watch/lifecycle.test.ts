// ---------- 趋势生命周期状态机 v2 + 指标 · 行为测试（Task 54 §2.2/§2.3 + Task 56 §2/§3/§四） ----------
// 覆盖：END_PENDING 证据计数（同根去重/中断清零/幂等键持久化）、周期出生 bar 排除、
//       方向感知动量衰减迟滞区间、反向确认立即结束、结构失效结束原因、
//       DATA_UNAVAILABLE 冻结（绝不伪装结束）、重启恢复不重复计数、指标与高周期聚合。

import { describe, expect, test } from 'bun:test';
import {
  createLifecycleState,
  normalizeLifecycleState,
  stepLifecycle,
  type LifecycleState,
} from '@/lib/market/trend-watch/lifecycle';
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
    barTime: partial.barTime !== undefined ? partial.barTime : 1_000,
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

describe('趋势生命周期状态机（lifecycle.ts · Task 56）', () => {
  test('确认生成 trendCycleId；ENDED 后新确认生成新周期（endReason 细分）', () => {
    let lc = createLifecycleState(SYM);
    // 3 根确认 up
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    expect(lc.phase).toBe('CONFIRMED_UP');
    expect(lc.cycleId).toBe(`${SYM}:L:100`);
    // 动量衰减（方向感知：up 周期 returnPct < 0.21% 即证据）→ 3 根独立收盘 K 线确认结束
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 2_000, now: 2_100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 3_100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 4_000, now: 4_100 })).state;
    expect(lc.phase).toBe('ENDED');
    expect(lc.endReason).toBe('DECAY');
    // 周期 id 保留（供持仓周期匹配离场）
    expect(lc.cycleId).toBe(`${SYM}:L:100`);
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
      const r = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 2_000, now: 2_100 + i }));
      lc = r.state;
      if (i > 0) expect(r.evidenceSkipped).toBe('DUPLICATE_BAR'); // 重复 bar 被忽略（日志还原用）
    }
    expect(lc.endEvidenceBars).toBe(1); // 同一根 barTime 只计一次
    expect(lc.endEvidenceBarTimes).toEqual([2_000]);
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 3_100 })).state;
    expect(lc.endEvidenceBars).toBe(2);
    expect(lc.endEvidenceBarTimes).toEqual([2_000, 3_000]);
  });

  test('迟滞区间（§四）：确认线 0.35% 与衰减线 0.21% 之间既不确认也不衰减；衰减证据方向感知', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    // returnPct 0.9%（强于确认线）→ 无证据
    let r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 0.9, barTime: 2_000, now: 2_100 }));
    expect(r.state.phase).toBe('CONFIRMED_UP');
    expect(r.state.endEvidenceBars).toBe(0);
    // returnPct 0.3%：低于确认线 0.35% 但高于衰减线 0.21% → 迟滞带内不算结束证据
    r = stepLifecycle(r.state, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 0.3, barTime: 3_000, now: 3_100 }));
    expect(r.state.phase).toBe('CONFIRMED_UP');
    expect(r.state.endEvidenceBars).toBe(0);
    // returnPct 0.2%（< 0.21%）→ 1 根衰减证据
    r = stepLifecycle(r.state, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 0.2, barTime: 4_000, now: 4_100 }));
    expect(r.state.phase).toBe('END_PENDING');
    expect(r.state.endEvidenceBars).toBe(1);
    // 证据中断（回到迟滞带上方）→ 恢复 CONFIRMED、清零（§3.1.4 条件恢复重置）
    r = stepLifecycle(r.state, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 1.2, barTime: 5_000, now: 5_100 }));
    expect(r.state.phase).toBe('CONFIRMED_UP');
    expect(r.state.endEvidenceBars).toBe(0);
    expect(r.state.endEvidenceBarTimes).toEqual([]);
  });

  test('多空口径对称（§四.6）：DOWN 周期衰减线 = -0.21%，方向收益高于 -0.21% 即证据', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', uteChangedAt: 100, now: 100 })).state;
    // returnPct -0.3%：仍在迟滞带内（|−0.3| 在 0.21~0.35 之间）→ 不算证据
    let r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', returnPct: -0.3, barTime: 2_000, now: 2_100 }));
    expect(r.state.endEvidenceBars).toBe(0);
    // returnPct -0.1%（> -0.21%，下跌动能衰减）→ 证据
    r = stepLifecycle(r.state, input({ utePhase: 'confirmed', uteDirection: 'down', returnPct: -0.1, barTime: 3_000, now: 3_100 }));
    expect(r.state.phase).toBe('END_PENDING');
    expect(r.state.endEvidenceBars).toBe(1);
    // UP 周期对 -0.5%（真实回撤）同样是证据（负收益 < 0.21）
    let lcUp = createLifecycleState(SYM);
    lcUp = stepLifecycle(lcUp, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    const rUp = stepLifecycle(lcUp, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: -0.5, barTime: 2_000, now: 2_100 }));
    expect(rUp.state.endEvidenceBars).toBe(1);
  });

  test('周期出生所在的 K 线不得作为该周期的结束证据（§2.3）', () => {
    // 真实毫秒时序：bar B 开盘 1_800_000_000_000，收盘 = 开盘 + 60_000；
    // 周期在 B 收盘后的评估中创建（cycleStartedAt > B 收盘时刻）
    const barB = 1_800_000_000_000;
    const barB1 = barB + 60_000;
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: barB + 61_000, now: barB + 61_000 })).state;
    expect(lc.cycleId).toBe(`${SYM}:L:${barB + 61_000}`);
    // 同一根出生 bar B 的重复评估出现衰减证据 → 被 BIRTH_BAR 排除
    const r = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: barB, now: barB + 62_000 }));
    expect(r.evidenceSkipped).toBe('BIRTH_BAR');
    expect(r.state.endEvidenceBars).toBe(0);
    // 出生后的新收盘 K 线 B+1 → 正常计入
    const r2 = stepLifecycle(r.state, input({ utePhase: 'idle', returnPct: 0.1, barTime: barB1, now: barB1 + 61_000 }));
    expect(r2.evidenceCounted).toBe(true);
    expect(r2.state.endEvidenceBars).toBe(1);
  });

  test('barTime=null / 数据不可用：绝不推进结束计数、绝不产生结束原因（§2.1/§3.2）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    // dataOk=true 但 barTime=null（未收盘/时间戳无效）→ 冻结，不计数
    let r = stepLifecycle(lc, input({ dataOk: true, barTime: null, now: 200 }));
    expect(r.state.phase).toBe('DATA_UNAVAILABLE');
    expect(r.state.endEvidenceBars).toBe(0);
    expect(r.state.endReason).toBeNull();
    // dataOk=false → 同样冻结
    r = stepLifecycle(r.state, input({ dataOk: false, barTime: 2_000, now: 300 }));
    expect(r.state.phase).toBe('DATA_UNAVAILABLE');
    expect(r.state.endEvidenceBars).toBe(0);
    // 恢复：证据继续计数（断供不重置也不虚增）
    const rec = stepLifecycle(r.state, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 4_000 }));
    expect(rec.state.endEvidenceBars).toBe(1);
  });

  test('重启恢复：状态 JSON roundtrip + normalize 后同一根 K 线不会再次计数（§2.1 持久化幂等）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 2_000, now: 2_100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 3_100 })).state;
    expect(lc.endEvidenceBars).toBe(2);
    // 模拟重启：序列化 → 反序列化 → normalize（service.boot 同路径）
    const restored = normalizeLifecycleState(JSON.parse(JSON.stringify(lc)) as LifecycleState & { symbol: string });
    expect(restored.endEvidenceBarTimes).toEqual([2_000, 3_000]);
    // 重启后同一根 K 线重复评估：不重复计数
    const r = stepLifecycle(restored, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 9_999 }));
    expect(r.evidenceSkipped).toBe('DUPLICATE_BAR');
    expect(r.state.endEvidenceBars).toBe(2);
    // 旧版本状态（无 endEvidenceBarTimes 字段）→ 从 endEvidenceBarTime 推导
    const legacy = { ...JSON.parse(JSON.stringify(lc)) } as Record<string, unknown>;
    delete legacy.endEvidenceBarTimes;
    const migrated = normalizeLifecycleState(legacy as unknown as LifecycleState & { symbol: string });
    expect(migrated.endEvidenceBarTimes).toEqual([3_000]);
    const r2 = stepLifecycle(migrated, input({ utePhase: 'idle', returnPct: 0.1, barTime: 3_000, now: 9_999 }));
    expect(r2.evidenceSkipped).toBe('DUPLICATE_BAR');
    expect(r2.state.endEvidenceBars).toBe(2);
  });

  test('反向趋势确认 → 立即 ENDED(CONFIRMED_REVERSAL)，不等衰减计数（§3.2）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    const r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', uteChangedAt: 400, now: 400 }));
    expect(r.state.phase).toBe('ENDED');
    expect(r.state.endReason).toBe('CONFIRMED_REVERSAL');
  });

  test('结构失效（ER/一致性）连续确认 → ENDED(STRUCTURE_INVALIDATION)（§3.2 细分）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    // ER < 0.25（returnPct 保持强势，仅结构失效）→ 3 根独立收盘 K 线
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 1.0, er: 0.1, barTime: 2_000, now: 2_100 })).state;
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 1.0, er: 0.1, barTime: 3_000, now: 3_100 })).state;
    const r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', returnPct: 1.0, er: 0.1, barTime: 4_000, now: 4_100 }));
    expect(r.state.phase).toBe('ENDED');
    expect(r.state.endReason).toBe('STRUCTURE_INVALIDATION');
  });

  test('DATA_UNAVAILABLE 期间反向确认：恢复后立即结束（不漏判）', () => {
    let lc = createLifecycleState(SYM);
    lc = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'up', uteChangedAt: 100, now: 100 })).state;
    lc = stepLifecycle(lc, input({ dataOk: false, barTime: null, now: 200 })).state;
    const r = stepLifecycle(lc, input({ utePhase: 'confirmed', uteDirection: 'down', uteChangedAt: 900, now: 900 }));
    expect(r.state.phase).toBe('ENDED');
    expect(r.state.endReason).toBe('CONFIRMED_REVERSAL');
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
