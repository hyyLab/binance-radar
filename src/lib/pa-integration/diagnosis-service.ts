// ---------- PA 整合 · 两阶段诊断服务（任务书 §五） ----------
// 自 PA Agent Web api/analyze/route.ts 移植的已验证链路：ZAI.create() → Stage1 →
// Stage2 + 逆势 coherence 拦截；新增 15m 背景 Stage1 调用。
// 纪律：
// - AI 输出全量归一化留档（不只提方向），normalize 与 PA Web 逐字段一致；
// - AI 失败抛出 / 返回 null → 上层按 WAIT 处理，绝不降级 UTE-only（任务书红线 7）；
// - AI 不越权：逆势方案被程序拦截回退为不下单（coherence，PA 原版闸门）。

import ZAI from 'z-ai-web-dev-sdk';
import {
  STAGE1_SYSTEM,
  STAGE2_SYSTEM,
  buildStage1User,
  buildHtfBackgroundUser,
  buildStage2User,
  extractJson,
  type PaStageMeta,
} from './prompts';
import { computeFeatures, type FeatureBundle } from './indicators';
import type { PaBar } from './kline-aggregator';
import type { PaDiagnosis, PaHtfBackground, PaRawPlan } from './types';

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.round(Math.min(hi, Math.max(lo, n)));
}

/** 归一化 Stage1 诊断（与 PA Web normalizeDiagnosis 一致） */
export function normalizeDiagnosis(raw: Record<string, unknown>): PaDiagnosis {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).slice(0, 8) : [];
  const bbs = Array.isArray(raw.bar_by_bar_summary)
    ? (raw.bar_by_bar_summary as Record<string, unknown>[])
        .slice(0, 5)
        .map((x) => ({
          bar: String(x.bar ?? '?'),
          role: String(x.role ?? '噪音'),
          reason: String(x.reason ?? ''),
        }))
    : [];
  const gate = (raw.gate_result ?? {}) as Record<string, unknown>;
  const dir = String(raw.direction ?? 'neutral');
  return {
    cycle_position: String(raw.cycle_position ?? 'unknown'),
    direction: dir === 'bullish' || dir === 'bearish' ? dir : 'neutral',
    diagnosis_confidence: clampInt(raw.diagnosis_confidence, 0, 100, 50),
    market_phase: raw.market_phase === 'transitioning' ? 'transitioning' : 'stable',
    support_levels: arr(raw.support_levels),
    resistance_levels: arr(raw.resistance_levels),
    detected_patterns: arr(raw.detected_patterns),
    key_signals: arr(raw.key_signals),
    htf_context: String(raw.htf_context ?? ''),
    entry_setup: String(raw.entry_setup ?? ''),
    bar_by_bar_summary: bbs,
    gate_result: {
      pass: gate.pass === true || gate.pass === 'true',
      reason: String(gate.reason ?? ''),
    },
    alternative_cycle_position:
      raw.alternative_cycle_position != null ? String(raw.alternative_cycle_position) : null,
  };
}

/** 15m 背景（消费同一 Stage1 输出形状的方向/阶段/结构字段） */
export function normalizeHtfBackground(raw: Record<string, unknown>): PaHtfBackground {
  const d = normalizeDiagnosis(raw);
  return {
    cycle_position: d.cycle_position,
    direction: d.direction,
    diagnosis_confidence: d.diagnosis_confidence,
    market_phase: d.market_phase,
    htf_context: d.htf_context,
    gate_result: d.gate_result,
  };
}

const VALID_ORDER_TYPES = ['限价单', '突破单', '市价单', '不下单'] as const;
type CnOrderType = (typeof VALID_ORDER_TYPES)[number];

/** 归一化 Stage2 决策（与 PA Web normalizeDecision 一致），映射为 PaRawPlan */
export function normalizePlan(symbol: string, raw: Record<string, unknown>): PaRawPlan {
  const ot = String(raw.order_type ?? '不下单');
  const orderTypeCn: CnOrderType = (VALID_ORDER_TYPES as readonly string[]).includes(ot)
    ? (ot as CnOrderType)
    : '不下单';
  const dir = String(raw.order_direction ?? '');
  const noOrder = orderTypeCn === '不下单';
  const dirOk = dir === '做多' ? 'LONG' : dir === '做空' ? 'SHORT' : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const orderType: PaRawPlan['orderType'] =
    orderTypeCn === '限价单' ? 'LIMIT' : orderTypeCn === '突破单' ? 'STOP_MARKET' : orderTypeCn === '市价单' ? 'MARKET' : 'MARKET';

  return {
    symbol,
    orderType: noOrder ? 'MARKET' : orderType,
    direction: noOrder ? 'LONG' : (dirOk ?? 'LONG'),
    entryPrice: noOrder ? null : num(raw.entry_price),
    entryBasisBar: raw.entry_basis_bar != null ? String(raw.entry_basis_bar) : null,
    entryBasisExtreme:
      raw.entry_basis_extreme === 'high' || raw.entry_basis_extreme === 'low'
        ? raw.entry_basis_extreme
        : null,
    entryRule: raw.entry_rule != null ? String(raw.entry_rule) : null,
    stopLoss: noOrder ? null : num(raw.stop_loss_price),
    takeProfit1: noOrder ? null : num(raw.take_profit_price),
    takeProfit2: noOrder ? null : num(raw.take_profit_price_2),
    estimatedWinRate: noOrder ? null : clampInt(raw.estimated_win_rate, 0, 100, 50),
    reasoning: String(raw.reasoning ?? ''),
    tradeConfidence: noOrder ? 0 : clampInt(raw.trade_confidence, 0, 100, 50),
    invalidationCondition:
      raw.invalidation_condition != null ? String(raw.invalidation_condition) : null,
    // 下单标记：noOrder 时以 entryPrice==null 表达（上层据此判 WAIT）
  };
}

export interface DiagnosisOutcome {
  diagnosis: PaDiagnosis;
  diagnosisJson: string;
  htf: PaHtfBackground | null;
  htfJson: string | null;
  latencyMs: number;
}

export interface PlanOutcome {
  plan: PaRawPlan | null; // null = AI 判定不下单（保留诊断，等待后续 K 线）
  rawJson: string;
  downgraded: boolean; // 逆势拦截触发
  latencyMs: number;
}

/** 单次 ZAI chat 调用（thinking disabled，与 PA Web 相同参数） */
async function zaiCall(system: string, user: string): Promise<string> {
  const zai = await ZAI.create();
  const resp = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'disabled' },
  });
  const content = resp.choices[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error('模型返回为空');
  return content;
}

/**
 * Stage1：5m 主诊断 + 15m 背景（两次独立调用）。
 * 背景调用失败不致命（htf=null → 协同判 UNCERTAIN/WAIT），主诊断失败抛错（本条分析失败）。
 */
export async function runStage1(meta: PaStageMeta, bars5m: PaBar[], bars15m: PaBar[]): Promise<DiagnosisOutcome> {
  const t0 = Date.now();
  const fb5m = computeFeatures(bars5m);
  const diagJson = await zaiCall(STAGE1_SYSTEM, buildStage1User(meta, fb5m));
  const diagnosis = normalizeDiagnosis(extractJson(diagJson));

  let htf: PaHtfBackground | null = null;
  let htfJson: string | null = null;
  try {
    const fb15 = computeFeatures(bars15m);
    htfJson = await zaiCall(STAGE1_SYSTEM, buildHtfBackgroundUser(meta, fb15));
    htf = normalizeHtfBackground(extractJson(htfJson));
  } catch {
    htf = null; // 背景缺失 → 协同 UNCERTAIN（任务书 §6.2-D）
  }

  return { diagnosis, diagnosisJson: diagJson, htf, htfJson, latencyMs: Date.now() - t0 };
}

/**
 * Stage2：交易决策（含逆势 coherence 拦截——PA 原版闸门，程序不可被 AI 越权）。
 * 返回 plan=null 表示「不下单」（有效结论，非失败）。
 */
export async function runStage2(
  meta: PaStageMeta,
  bars5m: PaBar[],
  diagnosisJson: string,
  diagnosis: PaDiagnosis,
): Promise<PlanOutcome> {
  const t0 = Date.now();
  const fb = computeFeatures(bars5m);
  const rawJson = await zaiCall(STAGE2_SYSTEM, buildStage2User(meta, fb, diagnosisJson));
  const plan = normalizePlan(meta.symbol, extractJson(rawJson));

  // coherence（PA Web enforceCoherence 移植）：决策方向与诊断方向矛盾 → 强制不下单
  const clash =
    (diagnosis.direction === 'bearish' && plan.direction === 'LONG' && plan.entryPrice != null) ||
    (diagnosis.direction === 'bullish' && plan.direction === 'SHORT' && plan.entryPrice != null);
  if (clash) {
    return {
      plan: null,
      rawJson,
      downgraded: true,
      latencyMs: Date.now() - t0,
    };
  }
  return { plan, rawJson, downgraded: false, latencyMs: Date.now() - t0 };
}
