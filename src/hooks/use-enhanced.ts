'use client';

import { useQuery } from '@tanstack/react-query';
import type { EnhancedEventDTO, EnhancedStats } from '@/lib/market/enhanced/types';
import type { TrendWatchRow, TrendWatchStats } from '@/lib/market/trend-watch/types';

export interface EnhancedResponse {
  ok: true;
  ts: number;
  events: { active: EnhancedEventDTO[]; ended: EnhancedEventDTO[] };
  stats: EnhancedStats;
}

export interface TrendWatchResponse {
  ok: true;
  ts: number;
  interval: string;
  market: string;
  pool: TrendWatchRow[];
  stats: TrendWatchStats;
}

export function useEnhancedAnomalies() {
  return useQuery({
    queryKey: ['enhanced-anomalies'],
    queryFn: async (): Promise<EnhancedResponse> => {
      const res = await fetch('/api/enhanced/anomalies', { cache: 'no-store' });
      return (await res.json()) as EnhancedResponse;
    },
    refetchInterval: 3000,
    staleTime: 2000,
    placeholderData: (prev) => prev,
  });
}

/** 趋势跟踪（Universal Trend Engine 集成）：相位/评分变化慢于异动，5s 轮询足够 */
export function useTrendWatch() {
  return useQuery({
    queryKey: ['enhanced-trends'],
    queryFn: async (): Promise<TrendWatchResponse> => {
      const res = await fetch('/api/enhanced/trends', { cache: 'no-store' });
      return (await res.json()) as TrendWatchResponse;
    },
    refetchInterval: 5000,
    staleTime: 3000,
    placeholderData: (prev) => prev,
  });
}
