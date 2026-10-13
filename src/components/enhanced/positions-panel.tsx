'use client';

// 升级版异动交易页签的持仓明细：与模拟盘共用 paper-account 数据源（3s 轮询，
// TanStack Query 同 key 去重），在此页即可盯持仓涨跌 + 一键平仓，无需来回切页签。

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PositionsTable } from '@/components/scanner/paper-panel';
import { useClosePosition, usePaperAccount } from '@/hooks/use-scanner';
import type { PaperAccountResponse } from '@/lib/market/types';
import { cn, pnlCls } from '@/lib/utils';
import { Wallet } from 'lucide-react';

export function PositionsPanel({
  onSelectSymbol,
  onManualTrade,
}: {
  onSelectSymbol: (symbol: string) => void;
  onManualTrade?: () => void;
}) {
  const { data, isLoading } = usePaperAccount();
  const close = useClosePosition();

  const acc: PaperAccountResponse['account'] | undefined = data?.account;
  const positions = data?.positions ?? [];
  const totalUpnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

  return (
    <Card className="border-border/70 bg-card">
      <div className="flex flex-wrap items-center gap-2 px-6 pb-1 pt-4">
        <Wallet className="h-4 w-4 text-gold" />
        <span className="text-sm font-bold">持仓明细</span>
        {positions.length > 0 && (
          <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold tabular-nums">
            {positions.length}
          </span>
        )}
        {acc && positions.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
            <span>
              浮动盈亏{' '}
              <span className={cn('font-bold', pnlCls(totalUpnl))}>
                {totalUpnl >= 0 ? '+' : ''}
                {totalUpnl.toFixed(2)} U
              </span>
            </span>
            <span>
              总权益{' '}
              <span className={cn('font-bold', pnlCls(acc.roiPct))}>{acc.equity.toFixed(2)} U</span>
            </span>
            <span>
              ROI{' '}
              <span className={cn('font-bold', pnlCls(acc.roiPct))}>
                {acc.roiPct >= 0 ? '+' : ''}
                {acc.roiPct.toFixed(2)}%
              </span>
            </span>
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">3 秒刷新 · 与模拟盘同账户</span>
        {onManualTrade && (
          <button
            onClick={onManualTrade}
            className="rounded-md bg-gold px-3 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-90"
          >
            手动开仓
          </button>
        )}
      </div>
      <CardContent className="p-0">
        <div className="custom-scroll overflow-x-auto">
          {isLoading && !data ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <PositionsTable
              positions={positions}
              onSelectSymbol={onSelectSymbol}
              onClose={(id) => close.mutate(id)}
              closing={close.isPending}
              emptyHint={
                onManualTrade
                  ? '暂无持仓 · 在上方事件池点「买入做多 / 卖出做空」，或点右上「手动开仓」一键建仓'
                  : '暂无持仓 · 在事件池卡片点「买入做多 / 卖出做空」一键建仓'
              }
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
