/**
 * PA 实时分析验证工具（验收 B）：对指定合约直跑完整 PA 链路——
 * 行情快照（1m→5m/15m 聚合）→ Stage1 主诊断 → 15m 背景 → UTE×PA 协同 → Stage2 → Validator。
 * 用法：bun scripts/pa-live-analyze.ts [SYMBOL=BTCUSDT]
 * 说明：本工具绕过 UTE 确认门槛直连 AI（验证数据链路与模型链路本身）；
 *       正式自动流程仍以全池扫描 + UTE 确认为准入（扫描层守卫）。
 */

import { buildPaMarketSnapshot } from '../src/lib/pa-integration/data-adapter';
import { runStage1, runStage2 } from '../src/lib/pa-integration/diagnosis-service';
import { coordinate } from '../src/lib/pa-integration/coordination-engine';
import { validatePlan } from '../src/lib/pa-integration/trade-plan-validator';
import { computeFeatures } from '../src/lib/pa-integration/indicators';
import { getEnhancedEngine } from '../src/lib/market/enhanced/engine';
import type { UnifiedTrendSignal } from '../src/lib/market/trend-watch/signal';

const symbol = (process.argv[2] ?? 'BTCUSDT').toUpperCase();
const uteDirArg = (process.argv[3] ?? 'up') as 'up' | 'down'; // 模拟 UTE 方向（仅协同输入用）

console.log(`\n== PA 实时分析验证：${symbol}（UTE 模拟方向=${uteDirArg}） ==`);

// 1) 引擎 + 行情快照（无缓存时自动回填）
const engine = getEnhancedEngine();
await engine.ensureStarted(); // 拉起行情采集（标记价/K线数据源）
await new Promise((r) => setTimeout(r, 3000)); // 等供价首拉
if (!engine.store.has(symbol)) {
  console.log('K 线缓存缺失，回填 1m …');
  await engine.store.backfill(symbol);
}
const snap = await buildPaMarketSnapshot(symbol, { triggerBackfill: true });
if (!snap.ok) {
  console.error(`✗ 行情快照不可用：${snap.waitReason}`);
  process.exit(1);
}
console.log(
  `✓ 快照：mark=${snap.mark} tick=${snap.tickSize} 5m=${snap.bars5m.length}根(最新=${new Date(snap.barTime5m! + 300_000).toISOString()}) 15m=${snap.bars15m.length}根 丢弃桶=${snap.droppedBuckets}`,
);

// 2) Stage1（5m 主诊断 + 15m 背景）
const t0 = Date.now();
const s1 = await runStage1({ symbol, timeframe: '5m' }, snap.bars5m, snap.bars15m);
console.log(
  `✓ Stage1：${s1.diagnosis.cycle_position}/${s1.diagnosis.direction} 置信=${s1.diagnosis.diagnosis_confidence} 闸门=${s1.diagnosis.gate_result.pass} 耗时=${s1.latencyMs}ms`,
);
console.log(`  HTF 15m：${s1.htf ? `${s1.htf.cycle_position}/${s1.htf.direction} 置信=${s1.htf.diagnosis_confidence}` : '缺失（背景调用失败）'}`);

// 3) 协同（UTE 用模拟方向；真实自动流程中来自 UnifiedTrendSignal）
const fakeSignal = {
  symbol, market: 'futures', interval: '1m', phase: uteDirArg === 'up' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN',
  direction: uteDirArg, trendCycleId: `${symbol}:${uteDirArg === 'up' ? 'L' : 'S'}:${Date.now()}`,
  score: 75, strength: 0.5, confirmCount: 3, changedAt: Date.now(),
} as unknown as UnifiedTrendSignal;
const coord = coordinate({
  ute: { direction: uteDirArg, phase: fakeSignal.phase, trendCycleId: fakeSignal.trendCycleId, score: 75, signalTime: Date.now(), sourceSignal: fakeSignal },
  pa: { diagnosis: s1.diagnosis, htf: s1.htf, analysisTime: Date.now(), barTime5m: snap.barTime5m! },
  mark: snap.mark,
});
console.log(`✓ 协同：${coord.state} → ${coord.decision}`);
for (const e of coord.evidences) console.log(`  · ${e}`);
console.log(`  理由：${coord.reason}`);

// 4) Stage2（仅 ALLOW 时；其余状态按任务书不进入 Stage2）
if (coord.decision === 'ALLOW') {
  const s2 = await runStage2({ symbol, timeframe: '5m' }, snap.bars5m, s1.diagnosisJson, s1.diagnosis);
  console.log(`✓ Stage2：${s2.plan ? `${s2.plan.orderType} ${s2.plan.direction} entry=${s2.plan.entryPrice} sl=${s2.plan.stopLoss} tp1=${s2.plan.takeProfit1} tp2=${s2.plan.takeProfit2} 胜率估计=${s2.plan.estimatedWinRate}%` : '不下单'}（拦截=${s2.downgraded}）耗时=${s2.latencyMs}ms`);
  if (s2.plan && s2.plan.entryPrice != null) {
    const fb = computeFeatures(snap.bars5m);
    const last5m = fb.features[fb.features.length - 1]!;
    const v = validatePlan(s2.plan, {
      last5m: { open: last5m.o, high: last5m.h, low: last5m.l, close: last5m.c, ts: last5m.ts },
      mark: snap.mark, tickSize: snap.tickSize, minRiskReward: 1.0, maxEntryDeviationPct: 0.3,
      barTime5m: snap.barTime5m!, now: Date.now(), uteDirection: uteDirArg,
      coordinationState: 'ALIGNED', analysisAgeMs: Date.now() - t0, maxAnalysisAgeMs: 10 * 60_000,
    });
    console.log(`${v.plan ? '✓' : '✗'} Validator：${v.plan ? `通过 RR=${v.plan.rewardRisk.toFixed(2)}` : '拒绝'}`);
    for (const c of v.checks) console.log(`  ${c.passed ? '✓' : '✗'} ${c.label}：${c.detail}`);
  }
} else {
  console.log('ℹ 协同未放行（WAIT/REJECT）——按任务书不进入 Stage2，本条即四态判定的真实验证');
}
console.log('\n验证完成（总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
