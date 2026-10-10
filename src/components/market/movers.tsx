'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtPrice, fmtVol } from '@/lib/format';
import type { TickerSnapshot } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { PctBadge } from './shared';
import { TrendingDown, TrendingUp } from 'lucide-react';

const MIN_QV = 1_000_000;

function MoverList({
  title,
  icon,
  items,
  onSelect,
  emptyText,
}: {
  title: string;
  icon: React.ReactNode;
  items: TickerSnapshot[];
  onSelect: (s: string) => void;
  emptyText: string;
}) {
  return (
    <Card className="border-border/70 bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="custom-scroll max-h-[56vh] overflow-y-auto px-2 pb-2">
          {items.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">{emptyText}</div>
          )}
          {items.map((t, i) => (
            <button
              key={t.symbol}
              onClick={() => onSelect(t.symbol)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-secondary/60"
              aria-label={`查看 ${t.symbol} 详情`}
            >
              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <span className="w-24 shrink-0 truncate font-semibold">
                {t.base}
                <span className="text-[10px] font-normal text-muted-foreground">/USDT</span>
              </span>
              <span className="flex-1 text-right tabular-nums">{fmtPrice(t.price)}</span>
              <PctBadge v={t.change24h} className="w-[70px] justify-center" />
              <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
                {fmtVol(t.quoteVolume24h)}
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function Movers({
  tickers,
  loading,
  onSelect,
}: {
  tickers: TickerSnapshot[];
  loading: boolean;
  onSelect: (s: string) => void;
}) {
  const { gainers, losers } = useMemo(() => {
    const eligible = tickers.filter((t) => t.quoteVolume24h >= MIN_QV);
    const sorted = [...eligible].sort((a, b) => b.change24h - a.change24h);
    return {
      gainers: sorted.slice(0, 20),
      losers: [...sorted].reverse().slice(0, 20),
    };
  }, [tickers]);

  if (loading && tickers.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="border-border/70 bg-card">
            <CardContent className="space-y-3 p-4">
              {Array.from({ length: 8 }).map((_, j) => (
                <Skeleton key={j} className="h-8 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        <MoverList
          title="24h 涨幅榜"
          icon={<TrendingUp className="h-4 w-4 text-up" />}
          items={gainers}
          onSelect={onSelect}
          emptyText="行情加载中，请稍候…"
        />
        <MoverList
          title="24h 跌幅榜"
          icon={<TrendingDown className="h-4 w-4 text-down" />}
          items={losers}
          onSelect={onSelect}
          emptyText="行情加载中，请稍候…"
        />
      </div>
      <p className={cn('text-xs text-muted-foreground')}>
        · 统计范围为 24h 成交额 ≥ 100 万 USDT 的交易对，点击查看 K 线详情。
      </p>
    </div>
  );
}
