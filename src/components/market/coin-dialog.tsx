'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useKlines, useTickers } from '@/hooks/use-market';
import { fmtPct, fmtPrice, fmtVol, pctClass } from '@/lib/format';
import type { TickerSnapshot } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { KlineChart } from './kline-chart';
import { PctBadge } from './shared';

const INTERVALS = [
  { v: '1m', label: '1分' },
  { v: '5m', label: '5分' },
  { v: '15m', label: '15分' },
  { v: '1h', label: '1时' },
  { v: '4h', label: '4时' },
  { v: '1d', label: '1天' },
] as const;

function StatItem({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm font-semibold tabular-nums', cls)}>{value}</div>
    </div>
  );
}

export function CoinDialog({
  symbol,
  onClose,
}: {
  symbol: string | null;
  onClose: () => void;
}) {
  const [interval, setInterval] = useState<string>('15m');
  const { data: klines, isLoading } = useKlines(symbol, interval, !!symbol);
  const { data: tickersResp } = useTickers();

  const ticker: TickerSnapshot | undefined = symbol
    ? tickersResp?.data.find((t) => t.symbol === symbol)
    : undefined;

  const base = symbol ? symbol.replace(/USDT$/, '') : '';
  const last = klines?.data[klines.data.length - 1];

  return (
    <Dialog open={!!symbol} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(880px,95vw)] overflow-y-auto custom-scroll">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DialogTitle className="text-xl font-bold">
            {base}
            <span className="text-sm font-normal text-muted-foreground">/USDT</span>
          </DialogTitle>
          {ticker && (
            <>
              <span className="text-xl font-bold tabular-nums">{fmtPrice(ticker.price)}</span>
              <PctBadge v={ticker.change24h} className="text-sm" />
            </>
          )}
        </div>
        <DialogDescription className="text-xs">
          {last
            ? `K 线时间轴为 UTC+8 · 最新收盘 ${fmtPrice(last.c)}`
            : '币安现货 K 线（服务端代理，缓存 20 秒）'}
        </DialogDescription>

        <div className="flex flex-wrap gap-1" role="tablist" aria-label="K 线周期">
          {INTERVALS.map((it) => (
            <button
              key={it.v}
              role="tab"
              aria-selected={interval === it.v}
              onClick={() => setInterval(it.v)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                interval === it.v
                  ? 'bg-gold/15 text-gold'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>

        {isLoading && klines == null ? (
          <Skeleton className="h-[340px] w-full" />
        ) : klines && klines.data.length > 0 ? (
          <KlineChart data={klines.data} />
        ) : (
          <div className="flex h-[340px] items-center justify-center rounded-lg border border-border/70 text-sm text-muted-foreground">
            {klines ? '暂无 K 线数据' : 'K 线加载失败，请稍后重试'}
          </div>
        )}

        {ticker && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatItem
              label="24h 最高"
              value={fmtPrice(ticker.high24h)}
              cls={ticker.price >= ticker.high24h ? 'text-up' : undefined}
            />
            <StatItem
              label="24h 最低"
              value={fmtPrice(ticker.low24h)}
              cls={ticker.price <= ticker.low24h ? 'text-down' : undefined}
            />
            <StatItem label="24h 开盘" value={fmtPrice(ticker.open)} />
            <StatItem label="24h 成交额" value={`${fmtVol(ticker.quoteVolume24h)} USDT`} />
            <StatItem
              label="5 分钟涨跌"
              value={fmtPct(ticker.chg5m)}
              cls={pctClass(ticker.chg5m)}
            />
            <StatItem
              label="15 分钟涨跌"
              value={fmtPct(ticker.chg15m)}
              cls={pctClass(ticker.chg15m)}
            />
            <StatItem label="1 小时涨跌" value={fmtPct(ticker.chg1h)} cls={pctClass(ticker.chg1h)} />
            <StatItem
              label="量比（vs 20 分钟均值）"
              value={ticker.volMultiple != null ? `${ticker.volMultiple.toFixed(1)}×` : '—'}
              cls={
                ticker.volMultiple != null && ticker.volMultiple >= 6 ? 'text-gold' : undefined
              }
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
