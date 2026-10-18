// ---------- Task 80 · 报告统计纯函数测试（bun test，无 DB 依赖） ----------
import { describe, expect, test } from 'bun:test';
import {
  applyStopLossWhatIf,
  computeGroupStats,
  counterfactualModelWorld,
  holdBucket,
  liquidationProfile,
  pnlPctOf,
  scoreBucket,
  sideGroupOf,
  sweepStopLoss,
  type ReportTrade,
} from '@/lib/market/trend-trade/report-stats';

/** 快速构造一笔平仓交易（margin 固定 10 USDT，便于占保证金 % 口径验算） */
function mk(partial: Partial<ReportTrade>): ReportTrade {
  return {
    positionId: 'p',
    symbol: 'BTCUSDT',
    signalSide: 'LONG',
    execSide: 'LONG',
    reversed: false,
    exitReason: 'TREND_ENDED',
    exitEndReason: null,
    openedAtMs: 0,
    closedAtMs: 0,
    holdMinutes: 60,
    leverage: 20,
    margin: 10,
    entryPrice: 100,
    exitPrice: 100,
    liqPrice: 95,
    pnlNet: 0,
    scoreAtOpen: 70,
    entryEr: 0.5,
    htfGate: 'ALIGNED',
    htf15mDir: 'up',
    entryRound: 1,
    mfe: null,
    mae: null,
    strategyId: 'short-swing-v1',
    trendCycleId: 'c',
    ...partial,
  };
}

describe('computeGroupStats', () => {
  test('空组全 null 零值，不产生 NaN', () => {
    const s = computeGroupStats([]);
    expect(s.trades).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.maxDrawdown).toBe(0);
    expect(Number.isNaN(s.netPnl)).toBe(false);
  });

  test('胜率/利润因子/期望值/盈亏比基本口径', () => {
    const s = computeGroupStats([
      mk({ positionId: 'a', pnlNet: 30, margin: 10 }),
      mk({ positionId: 'b', pnlNet: 10, margin: 10 }),
      mk({ positionId: 'c', pnlNet: -20, margin: 10 }),
    ]);
    expect(s.trades).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate!.toFixed(1)).toBe('66.7');
    expect(s.netPnl).toBe(20);
    expect(s.grossWin).toBe(40);
    expect(s.grossLoss).toBe(-20);
    expect(s.profitFactor!.toFixed(2)).toBe('2.00');
    expect(s.expectancy!.toFixed(2)).toBe('6.67');
    expect(s.payoffRatio!.toFixed(2)).toBe('1.00'); // |avgWin 20 / avgLoss -20| = 1
    expect(s.liquidations).toBe(0);
  });

  test('最大回撤与最长连亏（按 closedAt 升序）', () => {
    const s = computeGroupStats([
      mk({ positionId: 'a', pnlNet: 50, closedAtMs: 1 }),
      mk({ positionId: 'b', pnlNet: -30, closedAtMs: 2 }),
      mk({ positionId: 'c', pnlNet: -30, closedAtMs: 3 }),
      mk({ positionId: 'd', pnlNet: 20, closedAtMs: 4 }),
    ]);
    // 累计：50 → 20 → -10 → 10；峰谷差最大 = 50 - (-10) = 60
    expect(s.maxDrawdown).toBe(60);
    expect(s.maxConsecLoss).toBe(2);
  });

  test('无亏损单利润因子为 null（渲染层展示 inf），全亏组胜率 0', () => {
    expect(computeGroupStats([mk({ pnlNet: 5 })]).profitFactor).toBeNull();
    const allLoss = computeGroupStats([mk({ pnlNet: -5 })]);
    expect(allLoss.winRate).toBe(0);
    expect(allLoss.profitFactor!.toFixed(2)).toBe('0.00');
  });
});

describe('pnlPctOf / 分桶 / 分组键', () => {
  test('pnlPctOf = pnlNet / margin × 100', () => {
    expect(pnlPctOf(mk({ pnlNet: 3, margin: 10 }))).toBe(30);
    expect(pnlPctOf(mk({ pnlNet: -10, margin: 10 }))).toBe(-100);
  });

  test('scoreBucket / holdBucket 边界', () => {
    expect(scoreBucket(0)).toBe('<50');
    expect(scoreBucket(49.9)).toBe('<50');
    expect(scoreBucket(50)).toBe('50-69');
    expect(scoreBucket(70)).toBe('70-84');
    expect(scoreBucket(85)).toBe('>=85');
    expect(holdBucket(29)).toBe('<30m');
    expect(holdBucket(30)).toBe('30m-2h');
    expect(holdBucket(120)).toBe('2-6h');
    expect(holdBucket(360)).toBe('6-24h');
    expect(holdBucket(1440)).toBe('>=24h');
  });

  test('sideGroupOf：信号侧 ≠ 执行侧 = 反向（rev）', () => {
    expect(sideGroupOf(mk({ signalSide: 'LONG', execSide: 'SHORT', reversed: true }))).toBe('rev-short');
    expect(sideGroupOf(mk({ signalSide: 'SHORT', execSide: 'LONG', reversed: true }))).toBe('rev-long');
    expect(sideGroupOf(mk({ signalSide: 'LONG', execSide: 'LONG', reversed: false }))).toBe('fwd-long');
  });
});

describe('applyStopLossWhatIf / sweepStopLoss', () => {
  const trades = [
    // 盈利单：没到过 -20 → 保留
    mk({ positionId: 'w1', pnlNet: 25, mae: -12 }),
    // 先深亏后回本盈利：mae -35 → 在 -20 被截断（clippedWinner）
    mk({ positionId: 'w2', pnlNet: 15, mae: -35 }),
    // 亏损单：最终 -60%，mae -60 → 截断为 -20%（margin 10 → pnl = -2）
    mk({ positionId: 'l1', pnlNet: -6, mae: -60 }),
    // 强平单：-100%，mae -100 → 截断为 -20%
    mk({ positionId: 'liq', pnlNet: -10, exitReason: 'LIQUIDATED', mae: -100 }),
    // 老数据：mae 缺失 → 原样保留（uncovered）
    mk({ positionId: 'old', pnlNet: -8, mae: null }),
  ];

  test('mae ≤ -S 的单在 -S% 截断；先亏后赚单计入 clippedWinners；mae 缺失不参与', () => {
    const r = applyStopLossWhatIf(trades, 20);
    expect(r.clipped).toBe(3); // w2 / l1 / liq
    expect(r.clippedWinners).toBe(1); // w2
    expect(r.uncovered).toBe(1); // old
    const byId = new Map(r.trades.map((t) => [t.positionId, t]));
    expect(byId.get('w1')!.pnlNet).toBe(25); // 未触发
    expect(byId.get('w2')!.pnlNet).toBe(-2); // margin 10 × 20%
    expect(byId.get('l1')!.pnlNet).toBe(-2);
    expect(byId.get('liq')!.pnlNet).toBe(-2);
    expect(byId.get('old')!.pnlNet).toBe(-8); // 原样
  });

  test('扫描结果逐档精确（过紧止损会截断先亏后赚的盈利单 → 净利可能反而下降）', () => {
    const base = computeGroupStats(trades).netPnl; // 25+15-6-10-8 = 16
    expect(base).toBe(16);
    const rows = sweepStopLoss(trades, [20, 40, 80]);
    expect(rows.length).toBe(3);
    // -20%：截断 w2(+15→-2) / l1(-6→-2) / liq(-10→-2) → 25-2-2-2-8 = 11（过紧反而更差）
    const r20 = rows.find((r) => r.stopPct === 20)!;
    expect(r20.clipped).toBe(3);
    expect(r20.clippedWinners).toBe(1);
    expect(r20.stats.netPnl).toBe(11);
    expect(r20.deltaNetPnl).toBe(-5);
    // -40%：w2(mae -35) 未触发保留 +15；l1/liq 截断为 -4 → 25+15-4-4-8 = 24（最优档）
    const r40 = rows.find((r) => r.stopPct === 40)!;
    expect(r40.clipped).toBe(2);
    expect(r40.clippedWinners).toBe(0);
    expect(r40.stats.netPnl).toBe(24);
    expect(r40.deltaNetPnl).toBe(8);
    // -80%：仅强平单(mae -100→-8) 被截断 → 16 + 2 = 18
    const r80 = rows.find((r) => r.stopPct === 80)!;
    expect(r80.clipped).toBe(1);
    expect(r80.stats.netPnl).toBe(18);
    expect(r80.deltaNetPnl).toBe(2);
  });

  test('liquidationProfile 输出 liquidated/others 两列中位数', () => {
    const prof = liquidationProfile(trades);
    const hold = prof.find((p) => p.metric === 'hold_minutes_median')!;
    expect(hold.liquidated).toBe(60); // 只有 liq 一笔强平，hold 60
    expect(hold.others).toBe(60); // 其余 4 笔也都是 60
  });
});

describe('counterfactualModelWorld（模型世界反事实）', () => {
  test('反向单取镜像 -pnl，正向单原值', () => {
    const cf = counterfactualModelWorld([
      mk({ positionId: 'r1', reversed: true, pnlNet: 20 }),
      mk({ positionId: 'f1', reversed: false, pnlNet: -5 }),
    ]);
    expect(cf.actualNetPnl).toBe(15);
    expect(cf.reversedPnl).toBe(20);
    expect(cf.forwardPnl).toBe(-5);
    expect(cf.modelWorldNetPnl).toBe(-25); // -5 + (-20)
    expect(cf.note).toContain('近似');
  });
});
