/**
 * PA 整合（pa-action-v1）· 集成/回归测试（任务书 §十三）
 * 运行：DATABASE_URL=file:... bun scripts/pa-integration-tests.ts
 *
 * Part A 纯逻辑单元测试（无网络/无 DB）：
 *   A1 K线聚合（1m→5m/15m、缺失桶丢弃、OHLC 数学、升序）
 *   A2 UTE×PA 协同四态（任务书 §13.3 全场景）
 *   A3 交易计划 Validator（几何/RR/交易者方程/tick/新鲜度/偏离/订单语义/禁自动加宽）
 *   A4 风险预算仓位计算（公式/上限/最小保证金）
 *   A5 JSON 提取兜底 + 诊断归一化
 * Part B 系统级集成（走运行中的 radar 服务，真实行情）：
 *   B1 /api/pa-analysis/summary（验收 A：全池读取）
 *   B2 候选/订单/持仓/历史/配置 API
 *   B3 配置校验（非法值 400）
 *   B4 手动分析触发（验收 B；无确认趋势标的时如实跳过并记录）
 *   B5 回归：原系统页面与 API 不受影响（验收 E 部分）
 *   B6 数据库：Pa* 表存在且现有表数据未动
 */

import { aggregateFrom1m } from '../src/lib/pa-integration/kline-aggregator';
import { coordinate, PA_MIN_DIAG_CONFIDENCE } from '../src/lib/pa-integration/coordination-engine';
import { computeRiskReward, passesTraderEquation, validatePlan } from '../src/lib/pa-integration/trade-plan-validator';
import { computeRiskSizing } from '../src/lib/pa-integration/risk-sizing';
import { extractJson } from '../src/lib/pa-integration/prompts';
import { normalizeDiagnosis } from '../src/lib/pa-integration/diagnosis-service';
import type { Candle1m } from '../src/lib/market/enhanced/klines';
import type { CoordinationInput } from '../src/lib/pa-integration/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function t(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n━━ ${name}`);
}

// ============ Part A ============

// ---- A1 K线聚合 ----
section('A1 K线聚合（1m→5m/15m）');
{
  const base = 1_700_000_000_000; // 对齐 15m 桶（15m 对齐必然 5m 对齐，15 为 5 的倍数）
  const aligned = base - (base % 900_000);
  const candles: Candle1m[] = [];
  for (let i = 0; i < 30; i++) {
    const t = aligned + i * 60_000;
    candles.push({ t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, qv: 1000 });
  }
  const r5 = aggregateFrom1m(candles, 5, 96);
  t('5m 聚合产出 6 根完整桶', r5.bars.length === 6, `got ${r5.bars.length}`);
  t('桶升序', r5.bars.every((b, i) => i === 0 || b.ts > r5.bars[i - 1].ts));
  const first = r5.bars[0];
  t('OHLC 正确（o=首根open c=末根close h=max l=min）',
    first.open === 100 && first.close === 104.5 && first.high === 105 && first.low === 99,
    JSON.stringify(first));
  t('qv 求和正确', Math.abs(first.qv - 5000) < 1e-9, `${first.qv}`);

  // 缺失 1m → 桶丢弃
  const withGap = candles.filter((c) => c.t !== aligned + 7 * 60_000); // 第二桶缺 1 根
  const r5g = aggregateFrom1m(withGap, 5, 96);
  t('缺失 1m 的桶被丢弃（不伪装完整周期）', r5g.bars.length === 5 && r5g.droppedBuckets === 1, `bars=${r5g.bars.length} dropped=${r5g.droppedBuckets}`);

  const r15 = aggregateFrom1m(candles, 15, 32);
  t('15m 聚合产出 2 根完整桶', r15.bars.length === 2, `got ${r15.bars.length}`);
}

// ---- A2 协同四态 ----
section('A2 UTE×PA 协同四态（§13.3）');
const mkInput = (over: {
  uteDir?: 'up' | 'down' | 'flat';
  paDir?: 'bullish' | 'bearish' | 'neutral';
  paCycle?: string;
  paConf?: number;
  paPhase?: string;
  htfDir?: 'bullish' | 'bearish' | 'neutral' | null;
  htfCycle?: string;
  htfConf?: number;
  patterns?: string[];
  bbs?: { bar: string; role: string; reason: string }[];
}): CoordinationInput => ({
  ute: {
    direction: over.uteDir ?? 'up',
    phase: over.uteDir === 'down' ? 'CONFIRMED_DOWN' : 'CONFIRMED_UP',
    trendCycleId: 'BTCUSDT:L:1700000000000',
    score: 80,
    signalTime: Date.now(),
    sourceSignal: {} as CoordinationInput['ute']['sourceSignal'],
  },
  pa: {
    diagnosis: {
      cycle_position: over.paCycle ?? 'normal_channel',
      alternative_cycle_position: null,
      direction: over.paDir ?? 'bullish',
      diagnosis_confidence: over.paConf ?? 75,
      market_phase: over.paPhase ?? 'stable',
      support_levels: [], resistance_levels: [],
      detected_patterns: over.patterns ?? [],
      key_signals: [],
      htf_context: '',
      entry_setup: '',
      bar_by_bar_summary: over.bbs ?? [],
      gate_result: { pass: true, reason: '' },
    },
    htf: over.htfDir === null ? null : {
      cycle_position: over.htfCycle ?? 'normal_channel',
      direction: over.htfDir ?? 'bullish',
      diagnosis_confidence: over.htfConf ?? 70,
      market_phase: 'stable',
      htf_context: '',
      gate_result: { pass: true, reason: '' },
    },
    analysisTime: Date.now(),
    barTime5m: 1,
  },
  mark: 100,
});

{
  // ALIGNED：UTE 多 + PA 多 + 15m 多
  const r = coordinate(mkInput({}));
  t('ALIGNED：UTE 多 + PA 5m 多 + 15m 多 → ALLOW', r.state === 'ALIGNED' && r.decision === 'ALLOW', r.state);
  // ALIGNED：15m 中性也不反对
  const r2 = coordinate(mkInput({ htfDir: 'neutral' }));
  t('ALIGNED：15m 中性 → ALLOW', r2.state === 'ALIGNED', r2.state);

  // PULLBACK_DIVERGENCE：UTE 多 + PA 短期空 + 15m 仍多 + 形态仍属趋势通道
  const p = coordinate(mkInput({ paDir: 'bearish', htfDir: 'bullish' }));
  t('PULLBACK_DIVERGENCE：短期反向但 15m 支持原方向 → WAIT', p.state === 'PULLBACK_DIVERGENCE' && p.decision === 'WAIT', `${p.state}/${p.decision}`);
  const p2 = coordinate(mkInput({ paDir: 'bearish', htfDir: null })); // 背景缺失+低置信 → 证据不足
  t('PULLBACK_DIVERGENCE：背景缺失且证据不足 → WAIT（不反向）', p2.state === 'PULLBACK_DIVERGENCE', p2.state);

  // STRUCTURAL_CONFLICT：UTE 多 + PA 结构空 + AlwaysIn 高置信空 + 15m 空
  const c1 = coordinate(mkInput({ paDir: 'bearish', paConf: 80, htfDir: 'bearish', paCycle: 'trading_range' }));
  t('STRUCTURAL_CONFLICT：PA 反向+15m 反向+高置信 → REJECT', c1.state === 'STRUCTURAL_CONFLICT' && c1.decision === 'REJECT', `${c1.state}/${c1.decision} evid=${c1.evidences.length}`);
  const c2 = coordinate(mkInput({ paDir: 'bearish', paConf: 85, htfDir: 'bearish', bbs: [{ bar: 'K1', role: '结构', reason: '趋势阴线' }, { bar: 'K2', role: '结构', reason: '趋势阴线' }] }));
  t('STRUCTURAL_CONFLICT：高置信+15m 反向+趋势反向棒 → REJECT', c2.state === 'STRUCTURAL_CONFLICT', c2.state);

  // UNCERTAIN：低置信 / 闸门失败 / neutral
  const u1 = coordinate(mkInput({ paConf: PA_MIN_DIAG_CONFIDENCE - 10 }));
  t('UNCERTAIN：诊断置信度不足 → WAIT', u1.state === 'UNCERTAIN', u1.state);
  const u2 = coordinate(mkInput({ paDir: 'neutral' }));
  t('UNCERTAIN：PA neutral → WAIT', u2.state === 'UNCERTAIN', u2.state);
  const u3 = coordinate(mkInput({ htfDir: 'bearish' })); // 5m 同向但 15m 反向
  t('UNCERTAIN：5m 同向但 15m 明确反向 → WAIT（不开仓）', u3.state === 'UNCERTAIN', u3.state);
  const u4 = coordinate(mkInput({ paCycle: 'unknown' }));
  t('UNCERTAIN：形态不可读 → WAIT', u4.state === 'UNCERTAIN', u4.state);
  // 追高潮防线
  const u5 = coordinate(mkInput({ paCycle: 'spike' }));
  t('UNCERTAIN：spike 高潮禁追 → WAIT', u5.state === 'UNCERTAIN', u5.state);

  // UTE 无方向兜底
  const u6 = coordinate(mkInput({ uteDir: 'flat' }));
  t('UNCERTAIN：UTE 无确认方向 → WAIT', u6.state === 'UNCERTAIN', u6.state);

  // SHORT 镜像：UTE 空 + PA 空 + 15m 空 → ALIGNED
  const s1 = coordinate(mkInput({ uteDir: 'down', paDir: 'bearish', htfDir: 'bearish' }));
  t('ALIGNED（SHORT 镜像）→ ALLOW', s1.state === 'ALIGNED', s1.state);
  // SHORT 镜像回调
  const s2 = coordinate(mkInput({ uteDir: 'down', paDir: 'bullish', htfDir: 'bearish' }));
  t('PULLBACK_DIVERGENCE（SHORT 镜像）→ WAIT', s2.state === 'PULLBACK_DIVERGENCE', s2.state);
}

// ---- A3 Validator ----
section('A3 交易计划 Validator');
const baseCtx = {
  // K1 与 entry 几何自洽：多头限价单的 K1 low 必须高于 entry（未触及），
  // K1 close 不得低于 entry−tick；mark 与 entry 偏差 ≤ 0.3%
  last5m: { open: 100.1, high: 100.9, low: 100.15, close: 100.2, ts: 1 },
  mark: 100.2,
  tickSize: 0.1,
  minRiskReward: 1.0,
  maxEntryDeviationPct: 0.3,
  barTime5m: 1,
  now: Date.now(),
  uteDirection: 'up' as const,
  coordinationState: 'ALIGNED',
  analysisAgeMs: 60_000,
  maxAnalysisAgeMs: 10 * 60_000,
};
{
  const plan = (over: Partial<Parameters<typeof validatePlan>[0]>) => ({
    symbol: 'BTCUSDT', orderType: 'LIMIT' as const, direction: 'LONG' as const,
    entryPrice: 100, entryBasisBar: null, entryBasisExtreme: null, entryRule: null,
    stopLoss: 99, takeProfit1: 101.5, takeProfit2: 103,
    estimatedWinRate: 55, reasoning: '', tradeConfidence: 60, invalidationCondition: null,
    ...over,
  });

  const ok = validatePlan(plan({}), baseCtx);
  t('标准多头计划通过', ok.plan != null, JSON.stringify(ok.checks.filter((c) => !c.passed)));
  t('RR 计算正确', ok.plan != null && Math.abs(ok.plan.rewardRisk - 1.5) < 1e-9, ok.plan ? String(ok.plan.rewardRisk) : '');

  // 空头几何（K1 与 entry 几何自洽：空头限价单的 K1 high 必须低于 entry−tick，
  // K1 close 不得高于 entry+tick；mark 低于 entry=限价挂单在市价上方等反弹）
  const shortOk = validatePlan(plan({ direction: 'SHORT', entryPrice: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97 }), { ...baseCtx, uteDirection: 'down', mark: 99.85, last5m: { open: 99.6, high: 99.7, low: 99.3, close: 99.85, ts: 1 } });
  t('空头几何 TP2<TP1<entry<SL 通过', shortOk.plan != null, JSON.stringify(shortOk.checks.filter((c) => !c.passed)));

  // 几何错误：多头 stop > entry
  const badGeo = validatePlan(plan({ stopLoss: 100.5 }), baseCtx);
  t('多头 stop>entry 拒绝（GEOMETRY）', badGeo.plan == null && badGeo.checks.some((c) => c.id === 'GEOMETRY' && !c.passed));

  // RR 不足 → 拒绝且【不改写止损】（红线 9）：sl=99.7<entry，几何有效但 RR=0.67<1
  const planTight = plan({ stopLoss: 99.7, takeProfit1: 100.2 });
  const lowRR = validatePlan(planTight, baseCtx);
  t('RR 不足拒绝（RR_MIN）', lowRR.plan == null && lowRR.checks.some((c) => c.id === 'RR_MIN' && !c.passed), JSON.stringify(lowRR.checks.filter((c) => !c.passed)));
  t('禁自动加宽：输入计划的止损保持原值（未被修改）', planTight.stopLoss === 99.7, String(planTight.stopLoss));

  // 交易者方程：低胜率拒绝
  const badEq = validatePlan(plan({ estimatedWinRate: 30 }), baseCtx);
  t('交易者方程失败拒绝（30% 胜率 × RR1.5 期望为负）', badEq.plan == null && badEq.checks.some((c) => c.id === 'TRADER_EQ' && !c.passed));

  // tick 对齐
  const badTick = validatePlan(plan({ takeProfit2: 103.03 }), baseCtx);
  t('价格不合 tickSize 拒绝（TICK_SIZE）', badTick.plan == null && badTick.checks.some((c) => c.id === 'TICK_SIZE' && !c.passed));

  // 限价单错过入场位：K1 low 已 ≤ entry
  const staleLimit = validatePlan(plan({}), { ...baseCtx, last5m: { open: 100, high: 101, low: 99.9, close: 100.2, ts: 1 } });
  t('限价单已被 K1 触及 → 拒绝（LIMIT_FRESH）', staleLimit.plan == null && staleLimit.checks.some((c) => c.id === 'LIMIT_FRESH' && !c.passed));

  // 偏离超限（MARKET 单跳过 LIMIT_FRESH，直接命中 DEVIATION）：mark=101 → 偏差 1% > 0.3%
  const dev = validatePlan(plan({ orderType: 'MARKET' }), { ...baseCtx, mark: 101 });
  t('现价偏离超限拒绝（DEVIATION）', dev.plan == null && dev.checks.some((c) => c.id === 'DEVIATION' && !c.passed), JSON.stringify(dev.checks.filter((c) => !c.passed)));

  // 方向与 UTE 不一致
  const dirMis = validatePlan(plan({}), { ...baseCtx, uteDirection: 'down' });
  t('方向与 UTE 不一致拒绝（DIR_MATCH）', dirMis.plan == null && dirMis.checks.some((c) => c.id === 'DIR_MATCH' && !c.passed));

  // 协同非 ALIGNED
  const notAligned = validatePlan(plan({}), { ...baseCtx, coordinationState: 'PULLBACK_DIVERGENCE' });
  t('协同非 ALIGNED 拒绝（COORD_ALIGNED）', notAligned.plan == null && notAligned.checks.some((c) => c.id === 'COORD_ALIGNED' && !c.passed));

  // 突破单语义：多头触发价应高于市价（mark=99.9 使偏差 0.1% 在限内，仅命中 ORDER_SEMANTIC）
  const badStop = validatePlan(plan({ orderType: 'STOP_MARKET', entryPrice: 99.8, takeProfit1: 101.3, takeProfit2: 102.8 }), { ...baseCtx, mark: 99.9 });
  t('突破单触发价在市价下方拒绝（ORDER_SEMANTIC）', badStop.plan == null && badStop.checks.some((c) => c.id === 'ORDER_SEMANTIC' && !c.passed), JSON.stringify(badStop.checks.filter((c) => !c.passed)));

  // 数据过期
  const staleData = validatePlan(plan({}), { ...baseCtx, analysisAgeMs: 20 * 60_000 });
  t('分析数据过期拒绝（FRESH）', staleData.plan == null && staleData.checks.some((c) => c.id === 'FRESH' && !c.passed));

  // 原函数：computeRiskReward / passesTraderEquation
  const rr = computeRiskReward(100, 101.5, 99, 'LONG');
  t('computeRiskReward：risk=1 reward=1.5', rr != null && Math.abs(rr.risk - 1) < 1e-9 && Math.abs(rr.reward - 1.5) < 1e-9);
  t('交易者方程：55%×1.5 通过 / 40%×1.2 拒绝',
    passesTraderEquation(55, 1, 1.5) && !passesTraderEquation(40, 1, 1.2));
}

// ---- A4 风险预算 ----
section('A4 风险预算仓位计算');
{
  const r = computeRiskSizing({
    equity: 100, availableBalance: 95, entry: 100, stopLoss: 99,
    riskPerTradePct: 0.5, maxTotalRiskPct: 2, currentTotalRisk: 0,
    leverage: 10, leverageCap: 20, feeRate: 0.0002, tickSize: 0,
  });
  // budget = 0.5U / riskPerUnit 1 → qty 0.5；notional 50；margin 5
  t('qty = RiskBudget/|entry-sl| = 0.5', Math.abs(r.qty - 0.5) < 1e-9, String(r.qty));
  t('margin = notional/leverage = 5', Math.abs(r.margin - 5) < 1e-9, String(r.margin));
  t('riskAmount = 0.5U（=0.5%权益）', Math.abs(r.riskAmount - 0.5) < 1e-9, String(r.riskAmount));

  const over = computeRiskSizing({
    equity: 100, availableBalance: 95, entry: 100, stopLoss: 99,
    riskPerTradePct: 0.5, maxTotalRiskPct: 2, currentTotalRisk: 1.8,
    leverage: 10, leverageCap: 20, feeRate: 0.0002, tickSize: 0,
  });
  t('总敞口超限拒绝（1.8+0.5>2）', !over.ok && (over.reason ?? '').includes('总风险敞口'), over.reason ?? '');

  const broke = computeRiskSizing({
    equity: 100, availableBalance: 3, entry: 100, stopLoss: 99,
    riskPerTradePct: 0.5, maxTotalRiskPct: 2, currentTotalRisk: 0,
    leverage: 10, leverageCap: 20, feeRate: 0.0002, tickSize: 0,
  });
  t('余额不足拒绝（不变通）', !broke.ok && (broke.reason ?? '').includes('可用余额'), broke.reason ?? '');
}

// ---- A5 JSON / 归一化 ----
section('A5 JSON 提取与诊断归一化');
{
  const j = extractJson('前置噪声```json\n{"a":1,"b":"x",}\n```后置噪声');
  t('extractJson 容忍代码块与行尾逗号', (j as { a: number }).a === 1 && (j as { b: string }).b === 'x');
  // 与 PA Web 逐字段一致：direction 仅接受小写枚举（大写按 neutral 保守处理）
  const dUp = normalizeDiagnosis({ direction: 'BULLISH', diagnosis_confidence: '72', gate_result: { pass: 'true', reason: 'ok' } });
  t('归一化：大写 direction 保守降级 neutral（同 PA Web）', dUp.direction === 'neutral');
  const d = normalizeDiagnosis({ direction: 'bullish', diagnosis_confidence: '72', gate_result: { pass: 'true', reason: 'ok' } });
  t('归一化：小写枚举/字符串置信度/闸门容错', d.direction === 'bullish' && d.diagnosis_confidence === 72 && d.gate_result.pass === true);
}

// ============ Part B 系统级（走运行中服务） ============

const BASE = process.env.PA_TEST_BASE ?? 'http://127.0.0.1:3001';

async function jget(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  let body: Record<string, unknown> = {};
  try { body = (await r.json()) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: r.status, body };
}

async function jpost(path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  let body: Record<string, unknown> = {};
  try { body = (await r.json()) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: r.status, body };
}

async function partB(): Promise<void> {
  section('B1 总览与全池读取（验收 A）');
  const sum = await jget('/api/pa-analysis/summary');
  t('GET /api/pa-analysis/summary 200', sum.status === 200, JSON.stringify(sum.body).slice(0, 200));
  const pools = (sum.body.pools ?? []) as { poolId: string; count: number; error: string | null }[];
  t('接入 5 个业务池', pools.length === 5, `got ${pools.length}`);
  t('不只读取 UTE 单一候选池（异动/观察/探针/热门/扫描器）',
    ['anomaly-events', 'trend-watch', 'probe', 'hot-daily', 'scanner-universe'].every((id) => pools.some((p) => p.poolId === id)),
    pools.map((p) => p.poolId).join(','));
  const uni = (sum.body.universe ?? {}) as { totalRaw: number; unique: number };
  t('池内币种统计产出（totalRaw/unique）', typeof uni.totalRaw === 'number' && typeof uni.unique === 'number');
  console.log(`  ℹ 池明细: ${pools.map((p) => `${p.poolId}=${p.count}${p.error ? '(err)' : ''}`).join(' ')}；去重=${uni.unique}`);

  section('B2 候选/订单/持仓/历史 API');
  for (const path of ['/api/pa-analysis/candidates', '/api/pa-analysis/orders', '/api/pa-analysis/trades', '/api/pa-analysis/history', '/api/pa-analysis/config']) {
    const r = await jget(path);
    t(`GET ${path} 200`, r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  }

  section('B3 配置校验（后端）');
  const bad = await fetch(`${BASE}/api/pa-analysis/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ riskPerTradePct: 999 }),
  });
  t('非法配置 riskPerTradePct=999 → 400', bad.status === 400);
  const put = await fetch(`${BASE}/api/pa-analysis/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ riskPerTradePct: 0.5, maxPositions: 3, leverage: 10 }),
  });
  t('合法配置保存 200', put.status === 200);

  section('B4 手动分析触发（验收 B，依赖真实确认趋势标的）');
  const trends = await jget('/api/enhanced/trends');
  const poolRows = (trends.body.pool ?? []) as { symbol: string; phaseV2: string }[];
  const confirmed = poolRows.find((r) => r.phaseV2 === 'CONFIRMED_UP' || r.phaseV2 === 'CONFIRMED_DOWN');
  if (confirmed) {
    console.log(`  ℹ 使用确认趋势标的 ${confirmed.symbol}（${confirmed.phaseV2}）触发 PA 分析…`);
    const a = await jpost('/api/pa-analysis/analyze', { symbol: confirmed.symbol });
    t('POST analyze（指定 symbol）200', a.status === 200, JSON.stringify(a.body).slice(0, 160));
    // 轮询等待分析记录（最多 120s）
    let found = false;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const h = await jget(`/api/pa-analysis/history?symbol=${confirmed.symbol}&limit=1`);
      const recs = (h.body.records ?? []) as unknown[];
      if (recs.length > 0) { found = true; break; }
    }
    t('PA 分析记录产出（Stage1/协同/Stage2 全链路）', found);
    if (found) {
      const h = await jget(`/api/pa-analysis/history?symbol=${confirmed.symbol}&limit=1`);
      console.log(`  ℹ 最新分析：${JSON.stringify((h.body.records ?? [])[0]).slice(0, 400)}`);
    }
  } else {
    console.log('  ⚠ 当前无 CONFIRMED_* 趋势标的——按任务书 §四语义（WAIT）如实跳过真实 AI 分析验证');
    const scan = await jpost('/api/pa-analysis/analyze', {});
    t('POST analyze（全池扫描）200', scan.status === 200, JSON.stringify(scan.body).slice(0, 160));
  }

  section('B5 原系统回归（验收 E）');
  for (const [path, check] of [
    ['/', (b: string) => b.includes('binance') || b.includes('雷达') || b.length > 1000],
    ['/api/trend-trading', (b: Record<string, unknown>) => b.ok === true],
    ['/api/enhanced/trends', (b: Record<string, unknown>) => 'pool' in b],
    ['/api/market/tickers', (b: Record<string, unknown>) => 'tickers' in b || 'data' in b || Array.isArray(b)],
  ] as const) {
    try {
      const r = await fetch(`${BASE}${path}`, { cache: 'no-store' });
      const isJson = r.headers.get('content-type')?.includes('json');
      const body = isJson ? ((await r.json()) as Record<string, unknown>) : await r.text();
      const ok = r.status === 200 && (isJson ? (check as (b: Record<string, unknown>) => boolean)(body as Record<string, unknown>) : (check as (b: string) => boolean)(body as string));
      t(`回归 ${path} 200 且结构正常`, ok);
    } catch (e) {
      t(`回归 ${path}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  // 策略注册表未被破坏（原有 4 个 + PA stub）
  const tt = await jget('/api/trend-trading');
  const strategies = (tt.body.strategies ?? []) as { id: string }[];
  if (strategies.length > 0) {
    t('策略注册表完整（原 4 + pa-action-v1）',
      ['short-swing-v1', 'universal-trend-v1', 'major-p1-breakout-v1', 'strong-trend-v1', 'pa-action-v1']
        .every((id) => strategies.some((s) => s.id === id)),
      strategies.map((s) => s.id).join(','));
  } else {
    console.log('  ℹ /api/trend-trading 未返回策略列表字段（跳过注册表断言）');
  }
}

// ============ 运行 ============

console.log('PA 整合测试（pa-action-v1）');
const onlyUnit = process.argv.includes('--unit');
await partA_done();
if (!onlyUnit) await partB();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.error('失败项：');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

async function partA_done(): Promise<void> { /* 主流程在模块顶层已完成 A 部分 */ }
