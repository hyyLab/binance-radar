'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AnomaliesResponse,
  KlinesResponse,
  StatsResponse,
  TickersResponse,
} from '@/lib/market/types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const json = (await res.json()) as T | { ok: false; error: string };
  if (!('ok' in json) || json.ok !== true) {
    throw new Error('error' in json ? json.error : `请求失败 (${res.status})`);
  }
  return json;
}

export function useTickers() {
  return useQuery({
    queryKey: ['market-tickers'],
    queryFn: () => getJson<TickersResponse>('/api/market/tickers'),
    refetchInterval: 4000,
    staleTime: 3000,
    placeholderData: keepPreviousData,
  });
}

export function useAnomalies() {
  return useQuery({
    queryKey: ['market-anomalies'],
    queryFn: () => getJson<AnomaliesResponse>('/api/market/anomalies'),
    refetchInterval: 5000,
    staleTime: 4000,
    placeholderData: keepPreviousData,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['market-stats'],
    queryFn: () => getJson<StatsResponse>('/api/market/stats'),
    refetchInterval: 8000,
    staleTime: 6000,
    placeholderData: keepPreviousData,
  });
}

export function useKlines(symbol: string | null, interval: string, enabled: boolean) {
  return useQuery({
    queryKey: ['market-klines', symbol, interval],
    queryFn: () =>
      getJson<KlinesResponse>(
        `/api/market/klines?symbol=${encodeURIComponent(symbol ?? '')}&interval=${interval}&limit=180`,
      ),
    enabled: enabled && !!symbol,
    refetchInterval: 30_000,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}
