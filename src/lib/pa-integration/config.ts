// ---------- PA 整合（pa-action-v1）· 参数配置 ----------
// 唯一调参入口：代码常量 = 首次播种默认值；运行时真值 = DB PaActionConfig（/pa-analysis
// 页面可调，API 层后端校验——前端限制只是体验，校验必须在这里）。
// ⚠️ 与 trend-trade/config.ts 同纪律：全部阈值为初始工程参数，未经回测校准。

import { db } from '@/lib/db';
import type { PaActionConfig } from './types';

/** 独立模拟账户名（PaperAccount.name；与 default 手动盘、trend-auto-v1 完全隔离） */
export const PA_ACCOUNT_NAME = 'pa-auto-v1';

/** 策略 id（与 trend-trade/strategy/registry.ts 登记的 stub 同名） */
export const PA_STRATEGY_ID = 'pa-action-v1';

/** 提示词版本号（改动 prompts.ts 必须递增——分析幂等键组成，旧结果不复用） */
export const PA_PROMPT_VERSION = 'pa-1.0.0';

/** 代码默认配置（首次播种；运行时以 DB 行为准） */
export const PA_ACTION_DEFAULTS: PaActionConfig = {
  enabled: 0, // 默认停机：用户在 /pa-analysis 页面显式启用后才开始自动交易
  aiEnabled: 1,
  mainTimeframe: '5m',
  htfTimeframe: '15m',
  riskPerTradePct: 0.5, // 任务书 §7.5 初始建议
  maxPositions: 3,
  maxTotalRiskPct: 2,
  leverage: 10,
  leverageCap: 20,
  tp1CloseRatio: 0.5,
  breakevenAfterTp1: 0, // 默认关闭：不擅改 PA 原始计划
  orderExpiryMs: 30 * 60_000,
  entryMaxDeviationPct: 0.3,
  stopCooldownMs: 30 * 60_000,
  analysisCooldownMs: 15 * 60_000,
  aiConcurrency: 2,
  minRiskReward: 1.0,
  feeRate: 0.0002, // 与 trend-auto-v1 相同的 0.02% 双边
  slippageBps: 2,
  updatedAt: 0,
};

/** 配置校验（API PUT 用；返回错误信息，null = 通过）。前端只做体验，真校验在这里。 */
export function validatePaConfigPatch(
  patch: Record<string, unknown>,
): { error: string | null; clean: Partial<PaActionConfig> } {
  const clean: Partial<PaActionConfig> = {};
  const num = (key: string, lo: number, hi: number, int = false): string | null => {
    const v = patch[key];
    if (v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) {
      return `参数 ${key} 必须在 [${lo}, ${hi}] 内`;
    }
    (clean as Record<string, unknown>)[key] = int ? Math.round(n) : n;
    return null;
  };
  const flag = (key: string): string | null => {
    const v = patch[key];
    if (v === undefined) return null;
    clean[key as 'enabled' | 'aiEnabled'] = v === 1 || v === '1' || v === true ? 1 : 0;
    return null;
  };

  for (const err of [
    flag('enabled'),
    flag('aiEnabled'),
    num('riskPerTradePct', 0.1, 5),
    num('maxPositions', 1, 10, true),
    num('maxTotalRiskPct', 0.5, 20),
    num('leverage', 1, PA_ACTION_DEFAULTS.leverageCap, true),
    num('leverageCap', 1, 20, true),
    num('tp1CloseRatio', 0.1, 1),
    flag('breakevenAfterTp1'),
    num('orderExpiryMs', 60_000, 6 * 3_600_000, true),
    num('entryMaxDeviationPct', 0.05, 5),
    num('stopCooldownMs', 0, 24 * 3_600_000, true),
    num('analysisCooldownMs', 60_000, 6 * 3_600_000, true),
    num('aiConcurrency', 1, 4, true),
    num('minRiskReward', 0.5, 5),
    num('slippageBps', 0, 50, true),
  ]) {
    if (err) return { error: err, clean: {} };
  }
  if (clean.leverage != null && clean.leverageCap != null && clean.leverage > clean.leverageCap) {
    return { error: 'leverage 不得超过 leverageCap', clean: {} };
  }
  if (clean.tp1CloseRatio != null && (clean.tp1CloseRatio <= 0 || clean.tp1CloseRatio > 1)) {
    return { error: 'tp1CloseRatio 必须在 (0, 1] 内', clean: {} };
  }
  return { error: null, clean };
}

/** 读取运行时配置（无行时播种默认；单行 upsert 幂等） */
export async function loadPaConfig(): Promise<PaActionConfig> {
  const row = await db.paActionConfig.findUnique({ where: { id: PA_STRATEGY_ID } });
  if (row) {
    return {
      enabled: row.enabled,
      aiEnabled: row.aiEnabled,
      mainTimeframe: row.mainTimeframe,
      htfTimeframe: row.htfTimeframe,
      riskPerTradePct: row.riskPerTradePct,
      maxPositions: row.maxPositions,
      maxTotalRiskPct: row.maxTotalRiskPct,
      leverage: row.leverage,
      leverageCap: row.leverageCap,
      tp1CloseRatio: row.tp1CloseRatio,
      breakevenAfterTp1: row.breakevenAfterTp1,
      orderExpiryMs: row.orderExpiryMs,
      entryMaxDeviationPct: row.entryMaxDeviationPct,
      stopCooldownMs: row.stopCooldownMs,
      analysisCooldownMs: row.analysisCooldownMs,
      aiConcurrency: row.aiConcurrency,
      minRiskReward: row.minRiskReward,
      feeRate: row.feeRate,
      slippageBps: row.slippageBps,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
    };
  }
  const d = PA_ACTION_DEFAULTS;
  await db.paActionConfig.create({
    data: {
      id: PA_STRATEGY_ID,
      enabled: d.enabled,
      aiEnabled: d.aiEnabled,
      mainTimeframe: d.mainTimeframe,
      htfTimeframe: d.htfTimeframe,
      riskPerTradePct: d.riskPerTradePct,
      maxPositions: d.maxPositions,
      maxTotalRiskPct: d.maxTotalRiskPct,
      leverage: d.leverage,
      leverageCap: d.leverageCap,
      tp1CloseRatio: d.tp1CloseRatio,
      breakevenAfterTp1: d.breakevenAfterTp1,
      orderExpiryMs: d.orderExpiryMs,
      entryMaxDeviationPct: d.entryMaxDeviationPct,
      stopCooldownMs: d.stopCooldownMs,
      analysisCooldownMs: d.analysisCooldownMs,
      aiConcurrency: d.aiConcurrency,
      minRiskReward: d.minRiskReward,
      feeRate: d.feeRate,
      slippageBps: d.slippageBps,
    },
  });
  return { ...d, updatedAt: Date.now() };
}

/** 写回配置（已通过 validatePaConfigPatch 校验的 clean patch） */
export async function savePaConfig(clean: Partial<PaActionConfig>): Promise<PaActionConfig> {
  await loadPaConfig(); // 确保行存在
  const { updatedAt: _ignored, ...data } = clean as Partial<PaActionConfig> & { updatedAt?: number };
  void _ignored;
  const row = await db.paActionConfig.update({ where: { id: PA_STRATEGY_ID }, data });
  return {
    ...PA_ACTION_DEFAULTS,
    ...row,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
  } as PaActionConfig;
}
