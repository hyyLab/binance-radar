// ---------- pa-action-v1 · 策略注册表登记（防御性 stub） ----------
// 任务书 §7/§12 要求 pa-action-v1「遵守现有策略接口、注册表和参数配置规范」——本文件
// 在 registry 登记（UI 算法下拉可见、文档一致）；但其真实执行由独立调度器
// src/lib/pa-integration/scheduler.ts（PaActionTrader + PaAnalysisQueue）承担，原因：
// ① 任务书 §7.2 禁止在 AutoPaperTrader 10s 主循环同步等待 AI；
// ② §7.4/§7.6 要求的 LIMIT/STOP_MARKET 指定价入场与 TP1/TP2 部分止盈超出
//    StrategyEntryVerdict/StrategyExitVerdict 的表达能力；
// ③ §12 要求新旧策略同时运行、互不接管——AutoPaperTrader 是单策略槽 + 重置全表清空，
//    复用必然互相污染（独立账户 pa-auto-v1 + 独立状态表隔离）。
// 防御：若用户在趋势自动账户（trend-auto-v1）误选本算法，evaluateEntry 恒拒绝并给出
// 指引——绝不走 UTE 现价开仓路径。

import type {
  StrategyEntryVerdict,
  StrategyExitVerdict,
  StrategyMarketCtx,
  StrategyPositionCtx,
  TrendStrategy,
} from './types';
import type { UnifiedTrendSignal } from '../../trend-watch/signal';
import type { TrendTradeMetaRow } from '../repo';

const GUIDE = 'PA 策略由 /pa-analysis 页面的独立调度器执行（独立账户 pa-auto-v1）；请勿在趋势自动账户选择本算法';

export class PaActionStubStrategy implements TrendStrategy {
  readonly id = 'pa-action-v1';
  readonly name = 'PA 自动择机引擎（独立调度）';
  readonly description =
    'pa-action-v1：全池扫描 + UTE 趋势 + PA 两阶段价格行为诊断 + 四态协同 + 结构止损/分批止盈。' +
    '由 /pa-analysis 页面独立调度器执行（独立账户 pa-auto-v1），不在本账户循环内运行；此处登记仅为注册表可见性。';

  // 基础设施仍会调用 observe/evaluateEntry/evaluateExit——全部安全空转/拒绝
  observe(_symbol: string, _mark: number, _now: number): void {}

  evaluateEntry(_signal: UnifiedTrendSignal, _ctx: StrategyMarketCtx): StrategyEntryVerdict {
    return { want: false, side: null, modeTag: 'PA_INDEPENDENT', reason: GUIDE };
  }

  evaluateExit(_input: {
    meta: TrendTradeMetaRow;
    pos: StrategyPositionCtx;
    mark: number;
    signal: UnifiedTrendSignal | null;
    now: number;
  }): StrategyExitVerdict {
    return { exit: false, reason: null, detail: 'PA 持仓由 /pa-analysis 独立调度器管理（本账户无 PA 持仓）' };
  }

  nextRound(_symbol: string, _cycleId: string): number {
    return 1;
  }

  onOpen(_symbol: string, _cycleId: string, _barTime: number | null, _now: number): void {}
  onClose(_symbol: string, _cycleId: string, _reason: string, _now: number, _exitPrice?: number): void {}

  exportState(): Record<string, unknown> {
    return { stub: true, guide: GUIDE };
  }

  importState(_raw: unknown): void {}

  bindPersistence(_fn: (strategyId: string, symbol: string, json: string) => void): void {}
}
