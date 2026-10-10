'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtPrice, fmtVol, pctClass } from '@/lib/format';
import type { StatsResponse } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bitcoin, Zap } from 'lucide-react';

function StatCard({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/70 bg-card">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className="mt-1.5">{children}</div>
      </CardContent>
    </Card>
  );
}

export function StatsBar({
  stats,
  isLoading,
  isError,
  onGotoAnomalies,
}: {
  stats: StatsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  onGotoAnomalies: () => void;
}) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="border-border/70 bg-card">
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-3 w-12" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const total = stats.advancing + stats.declining + stats.flat;
  const advPct = total > 0 ? (stats.advancing / Math.max(1, stats.advancing + stats.declining)) * 100 : 50;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <StatCard
        icon={<Bitcoin className="h-3.5 w-3.5 text-gold" />}
        label="BTC / USDT"
      >
        <div className="text-lg font-bold tabular-nums sm:text-xl">
          {stats.btc ? fmtPrice(stats.btc.price) : '—'}
        </div>
        <div className={cn('text-xs font-medium tabular-nums', pctClass(stats.btc?.change24h))}>
          {stats.btc
            ? `${stats.btc.change24h > 0 ? '+' : ''}${stats.btc.change24h.toFixed(2)}% (24h)`
            : '—'}
        </div>
      </StatCard>

      <StatCard icon={<span className="text-sm font-bold text-gold">Ξ</span>} label="ETH / USDT">
        <div className="text-lg font-bold tabular-nums sm:text-xl">
          {stats.eth ? fmtPrice(stats.eth.price) : '—'}
        </div>
        <div className={cn('text-xs font-medium tabular-nums', pctClass(stats.eth?.change24h))}>
          {stats.eth
            ? `${stats.eth.change24h > 0 ? '+' : ''}${stats.eth.change24h.toFixed(2)}% (24h)`
            : '—'}
        </div>
      </StatCard>

      <StatCard icon={<BarChart3 className="h-3.5 w-3.5 text-gold" />} label="全市场 24h 成交额">
        <div className="text-lg font-bold tabular-nums sm:text-xl">
          {fmtVol(stats.totalQuoteVolume)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">USDT</span>
        </div>
        <div className="text-xs text-muted-foreground">监测 {stats.symbolsTracked} 个交易对</div>
      </StatCard>

      <StatCard
        icon={
          <span className="flex items-center">
            <ArrowUpRight className="h-3.5 w-3.5 text-up" />
            <ArrowDownRight className="-ml-1 h-3.5 w-3.5 text-down" />
          </span>
        }
        label="上涨 / 下跌 家数"
      >
        <div className="text-lg font-bold tabular-nums">
          <span className="text-up">{stats.advancing}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className="text-down">{stats.declining}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-down/60">
          <div
            className="h-full rounded-full bg-up transition-all duration-700"
            style={{ width: `${advPct}%` }}
          />
        </div>
      </StatCard>

      <button
        onClick={onGotoAnomalies}
        className="group text-left focus-visible:outline-none"
        aria-label="查看异动监控"
      >
        <StatCard
          icon={<Zap className="h-3.5 w-3.5 text-gold" />}
          label="近 1 小时异动"
        >
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tabular-nums text-gold sm:text-xl">
              {stats.anomaliesLast1h}
            </span>
            <span className="text-xs text-muted-foreground">次</span>
            <span className="ml-auto text-xs text-muted-foreground transition-colors group-hover:text-gold">
              查看 →
            </span>
          </div>
          <div className="text-xs text-muted-foreground">24h 内共 {stats.anomaliesLast24h} 次</div>
        </StatCard>
      </button>

      {isError && (
        <div className="col-span-full flex items-center gap-2 rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down md:col-span-5">
          <Activity className="h-4 w-4" />
          行情服务连接异常，正在自动重试…
        </div>
      )}
    </div>
  );
}
