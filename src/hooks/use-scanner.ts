'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import type {
  LevelsResponse,
  PaperAccountResponse,
  PaperCloseAllResponse,
  PaperCloseResponse,
  PaperDepositResponse,
  PaperOpenResponse,
  PaperTradesResponse,
  SignalsResponse,
} from '@/lib/market/types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const json = (await res.json()) as T | { ok: false; error: string };
  if (!('ok' in json) || json.ok !== true) {
    throw new Error('error' in json ? json.error : `请求失败 (${res.status})`);
  }
  return json;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T | { ok: false; error: string };
  if (!('ok' in json) || json.ok !== true) {
    throw new Error('error' in json ? json.error : `请求失败 (${res.status})`);
  }
  return json;
}

export function useSignals() {
  return useQuery({
    queryKey: ['scanner-signals'],
    queryFn: () => getJson<SignalsResponse>('/api/scanner/signals'),
    refetchInterval: 15_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
}

export function useLevels() {
  return useQuery({
    queryKey: ['scanner-levels'],
    queryFn: () => getJson<LevelsResponse>('/api/scanner/levels'),
    refetchInterval: 20_000,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function usePaperAccount() {
  return useQuery({
    queryKey: ['paper-account'],
    queryFn: () => getJson<PaperAccountResponse>('/api/paper/account'),
    refetchInterval: 3000,
    staleTime: 2000,
    placeholderData: (prev) => prev,
  });
}

/** 按币种查询交易流水（K 线图标注开仓/平仓位置用） */
export function usePaperTrades(symbol: string | null) {
  return useQuery({
    queryKey: ['paper-trades', symbol],
    queryFn: () =>
      getJson<PaperTradesResponse>(`/api/paper/trades?symbol=${encodeURIComponent(symbol ?? '')}`),
    enabled: !!symbol,
    refetchInterval: 15_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
}

export interface OpenPositionInput {
  symbol: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  margin: number;
}

export function useOpenPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenPositionInput) =>
      postJson<PaperOpenResponse>('/api/paper/open', input),
    onSuccess: (data, vars) => {
      toast({
        title: `${vars.side === 'LONG' ? '买入做多' : '卖出做空'}已成交`,
        description: `${data.position.base}/USDT · ${vars.leverage}x 杠杆 · 开仓价 ${data.position.entryPrice}`,
      });
      void qc.invalidateQueries({ queryKey: ['paper-account'] });
    },
    onError: (err: Error) => {
      toast({ title: '开仓失败', description: err.message, variant: 'destructive' });
    },
  });
}

export function useClosePosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (positionId: string) =>
      postJson<PaperCloseResponse>('/api/paper/close', { positionId }),
    onSuccess: (data) => {
      const profit = data.pnl >= 0;
      toast({
        title: `已平仓 ${data.symbol.replace(/USDT$/, '')}`,
        description: `${data.side === 'LONG' ? '多' : '空'}单 · 净盈亏 ${profit ? '+' : ''}${data.pnl.toFixed(2)} USDT`,
        variant: profit ? 'default' : 'destructive',
      });
      void qc.invalidateQueries({ queryKey: ['paper-account'] });
    },
    onError: (err: Error) => {
      toast({ title: '平仓失败', description: err.message, variant: 'destructive' });
    },
  });
}

/** 一键平仓所有持仓 */
export function useCloseAllPositions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<PaperCloseAllResponse>('/api/paper/close-all', {}),
    onSuccess: (data) => {
      const profit = data.totalPnl >= 0;
      const parts: string[] = [`共平仓 ${data.closed} 个仓位`];
      if (data.skipped > 0) parts.push(`${data.skipped} 个因行情不可用跳过`);
      toast({
        title: '全部持仓已平仓',
        description: `${parts.join('，')} · 总净盈亏 ${profit ? '+' : ''}${data.totalPnl.toFixed(2)} USDT`,
        variant: profit ? 'default' : 'destructive',
      });
      void qc.invalidateQueries({ queryKey: ['paper-account'] });
    },
    onError: (err: Error) => {
      toast({ title: '一键平仓失败', description: err.message, variant: 'destructive' });
    },
  });
}

/** 充值（模拟资金，增加总权益，ROI 本金基数同步增加） */
export function useDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amount: number) => postJson<PaperDepositResponse>('/api/paper/deposit', { amount }),
    onSuccess: (data, amount) => {
      toast({
        title: '充值成功',
        description: `+${amount.toFixed(2)} USDT 已到账 · 当前可用 ${data.balance.toFixed(2)} · 累计充值 ${data.totalDeposited.toFixed(2)}`,
      });
      void qc.invalidateQueries({ queryKey: ['paper-account'] });
    },
    onError: (err: Error) => {
      toast({ title: '充值失败', description: err.message, variant: 'destructive' });
    },
  });
}

export function useResetAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ ok: true }>('/api/paper/reset', {}),
    onSuccess: () => {
      toast({ title: '账户已重置', description: '资金已恢复至 1000 USDT' });
      void qc.invalidateQueries({ queryKey: ['paper-account'] });
    },
    onError: (err: Error) => {
      toast({ title: '重置失败', description: err.message, variant: 'destructive' });
    },
  });
}
