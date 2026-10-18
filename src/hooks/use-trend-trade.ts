'use client';

// ---------- 趋势自动模拟交易 · 数据 hooks（Task 54 §5） ----------
// 总览 5s 轮询（持仓/账户/模式）；历史 20s 轮询（筛选条件变化即刷新）。
// Task 79：自动平仓（趋势结束/反向/策略离场/强平）不经前端 mutation，历史原本
// 只能等自身 20s 轮询才发现变化——用户看到「仓位已消失、历史迟迟不出现」。
// 现在监听总览 stats.closedCount（与历史行数同源的计数，5s 轮询内必变），
// 一变立即失效历史缓存：自动平仓可见延迟 ~20s → ~5s，与手动平仓体验一致。
// 控制操作用 mutation + 手动失效缓存，按钮态由服务端 mode 驱动。

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface TrendPositionRow {
  positionId: string;
  symbol: string;
  base: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  margin: number;
  qty: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  notional: number;
  openedAt: string;
  holdMinutes: number;
  unrealizedGross: number;
  estCloseFee: number;
  netEst: number;
  trend: {
    phase: string;
    direction: string;
    score: number;
    dataFresh: boolean;
    dataUnavailableReason: string | null;
    endEvidenceBars: number;
    endPendingSince: number | null;
    trendCycleId: string | null;
    conflict: boolean;
    reason: string;
    volRegime: string;
    htfAgree: boolean | null;
  } | null;
  trendCycleId: string | null;
  scoreAtOpen: number | null;
  waitingEndConfirm: boolean;
}

/** Task 57-c：参数控制台单个参数（overview config.params 元素） */
export interface RuntimeParamItem {
  key: string;
  scope: 'strategy' | 'infra';
  group: string;
  label: string;
  type: 'number' | 'boolean';
  /** 当前生效值（代码默认 + DB 覆盖合并） */
  value: number | boolean;
  default: number | boolean;
  /** true = 当前值 ≠ 代码默认（控制台徽标用） */
  overridden: boolean;
  unit?: string;
  /** number 型合法范围（UI 输入校验用） */
  min?: number;
  max?: number;
  /** 参数含义（说明书同源文案） */
  desc: string;
  /** 调大/调小的效果 */
  effect?: string;
}

export interface TrendOverview {
  ok: boolean;
  ts: number;
  mode: 'RUNNING' | 'PAUSED' | 'STOPPED';
  service: {
    on: boolean;
    startedAt: number;
    lastTickAt: number;
    lastError: string | null;
    trendSignalCount: number;
    trendLastScanAt: number;
  };
  config: {
    accountName: string;
    initialCapital: number;
    marginRatio: number;
    /** Task 58：min(设定比例, 95%÷持仓数)——当前仓位数下满仓可开的实际单仓比例 */
    effMarginRatio: number;
    leverage: number;
    maxPositions: number;
    slippageBps: number;
    /** Task 57：当前算法 id */
    strategyId: string;
    /** Task 57：可选策略列表（UI 下拉数据源） */
    strategies: { id: string; name: string; description: string }[];
    /** Task 57-c：参数控制台（定义 + 当前生效值） */
    params: RuntimeParamItem[];
  };
  account: {
    balance: number;
    marginUsed: number;
    unrealizedPnl: number;
    equity: number;
    initialCapital: number;
    totalDeposited: number;
    peakEquity: number;
    currentDrawdownPct: number;
  };
  stats: {
    realizedNetWithSlip: number;
    feePaid: number;
    winRate: number;
    closedCount: number;
    liquidatedCount: number;
    openCount: number;
    tradeCount: number;
    roiPct: number;
  };
  positions: TrendPositionRow[];
  recentSkips: { t: number; symbol: string; reason: string; cycleId?: string }[];
  recentDecisions: {
    id: string;
    symbol: string;
    action: string;
    cycleId: string;
    positionId: string | null;
    detail: string;
    createdAt: number;
  }[];
}

export interface TrendTradeRow {
  positionId: string;
  symbol: string;
  base: string;
  /** 实际执行方向（反向跟随开启时 = 模型信号取反；历史/K线/盈亏展示均按此） */
  side: 'LONG' | 'SHORT';
  /** Task 77：模型信号方向（反向跟随开启时与 side 互为镜像；正常跟随 = side） */
  signalSide?: 'LONG' | 'SHORT';
  /** Task 77：是否反向执行（signalSide ≠ side）——历史卡片显示「反」徽标 */
  reversed?: boolean;
  /** Task 63：开仓时使用的算法（registry id；历史旧行兜底 short-swing-v1） */
  strategyId?: string;
  /** Task 63：算法展示名（短周期套利 / 通用趋势引擎；历史明细「算法」列） */
  strategyName?: string;
  openedAt: string;
  closedAt: string;
  holdMinutes: number | null;
  entryPrice: number;
  exitPrice: number | null;
  margin: number;
  leverage: number;
  notionalOpen: number;
  grossPnl: number | null;
  openFee: number;
  closeFee: number;
  slippageEst: number;
  netPnl: number | null;
  netPnlWithSlip: number | null;
  trendCycleId: string;
  trendPhaseAtOpen: string;
  scoreAtOpen: number;
  exitReason: string | null;
  exitSignal: { endReason?: string; reason?: string } | null;
  signalAtOpen: { reason?: string; features?: { volRegime?: string; atrPct?: number; efficiencyRatio?: number } } | null;
}

export function useTrendTrading() {
  return useQuery({
    queryKey: ['trend-trading'],
    queryFn: async (): Promise<TrendOverview> => {
      const res = await fetch('/api/trend-trading', { cache: 'no-store' });
      return (await res.json()) as TrendOverview;
    },
    refetchInterval: 5000,
    staleTime: 3000,
    placeholderData: (prev) => prev,
  });
}

export function useTrendTradeHistory(symbol: string, sort: string, order: string) {
  const queryClient = useQueryClient();
  // Task 79：closedCount 变化 ⇒ 历史行集合必变（同源计数）⇒ 立即失效历史缓存。
  // 首次观测不触发（挂载时查询本就会拉取）；重置清场使计数下降时同样触发。
  const closedCount = useTrendTrading().data?.stats.closedCount;
  const lastClosedCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (closedCount == null) return;
    const last = lastClosedCountRef.current;
    lastClosedCountRef.current = closedCount;
    if (last !== null && last !== closedCount) {
      void queryClient.invalidateQueries({ queryKey: ['trend-trading-history'] });
    }
  }, [closedCount, queryClient]);

  return useQuery({
    queryKey: ['trend-trading-history', symbol, sort, order],
    queryFn: async (): Promise<{ ok: boolean; trades: TrendTradeRow[] }> => {
      const params = new URLSearchParams({ symbol, sort, order, limit: '200' });
      const res = await fetch(`/api/trend-trading/trades?${params}`, { cache: 'no-store' });
      return (await res.json()) as { ok: boolean; trades: TrendTradeRow[] };
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
}

export function useTrendTradeControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      action: string;
      positionId?: string;
      amount?: number;
      value?: number | string;
      /** Task 57-c：setRuntimeParams 的参数全量值（键 → number|boolean） */
      params?: Record<string, number | boolean>;
    }) => {
      const res = await fetch('/api/trend-trading/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return (await res.json()) as {
        ok: boolean;
        message?: string;
        error?: string;
        mode?: string;
        note?: string;
        balance?: number;
        totalDeposited?: number;
        marginRatio?: number;
        maxPositions?: number;
        strategyId?: string;
        closed?: number;
        skipped?: number;
      };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trend-trading'] });
      void qc.invalidateQueries({ queryKey: ['trend-trading-history'] });
    },
  });
}
