'use client';

import { useQuery } from '@tanstack/react-query';
import type { EnhancedEventDTO, EnhancedStats } from '@/lib/market/enhanced/types';

export interface EnhancedResponse {
  ok: true;
  ts: number;
  events: { active: EnhancedEventDTO[]; ended: EnhancedEventDTO[] };
  stats: EnhancedStats;
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
