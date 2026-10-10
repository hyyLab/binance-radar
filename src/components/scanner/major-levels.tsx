'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtPrice } from '@/lib/format';
import type { SymbolLevels } from '@/lib/market/indicators';
import { cn } from '@/lib/utils';
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react';

type Kind = 'SUPPORT' | 'RESIST';

function LevelCard({
  kind,
  levels,
  loading,
  onTrade,
  onSelectSymbol,
}: {
  kind: Kind;
  levels: SymbolLevels[];
  loading: boolean;
  onTrade: (symbol: string, side: 'LONG' | 'SHORT') => void;
  onSelectSymbol: (symbol: string) => void;
}) {
  const isSupport = kind === 'SUPPORT';

  const rows = useMemo(() => {
    return levels
      .filter((l) => (isSupport ? l.support : l.resist))
      .sort((a, b) => {
        const da = Math.abs(isSupport ? a.support!.distancePct : a.resist!.distancePct);
        const db = Math.abs(isSupport ? b.support!.distancePct : b.resist!.distancePct);
        return da - db;
      })
      .slice(0, 12);
  }, [levels, isSupport]);

  const tradeSide = isSupport ? 'LONG' : 'SHORT';

  return (
    <Card className="border-border/70 bg-card">
      <CardHeader className="pb-2">
        <CardTitle
          className={cn('flex items-center gap-2 text-sm font-bold', isSupport ? 'text-up' : 'text-down')}
        >
          {isSupport ? (
            <ArrowDownToLine className="h-4 w-4" />
          ) : (
            <ArrowUpToLine className="h-4 w-4" />
          )}
          {isSupport ? '大级别支撑 · 做多参考' : '大级别压力 · 做空参考'}
        </CardTitle>
        <p className="text-[11px] font-normal text-muted-foreground">
          4h 分形极值聚类 · 约 20 日窗口 · 按距现价远近排序
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="custom-scroll max-h-[32vh] overflow-y-auto px-2 pb-2">
          {loading && levels.length === 0 && (
            <div className="space-y-2 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div className="px-3 py-10 text-center text-xs text-muted-foreground">
              首次扫描中，约需 1-2 分钟…
            </div>
          )}
          {rows.map((l) => {
            const level = isSupport ? l.support! : l.resist!;
            return (
              <div
                key={l.symbol}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/50"
              >
                <button
                  onClick={() => onSelectSymbol(l.symbol)}
                  className="w-20 shrink-0 truncate text-left font-semibold hover:text-gold"
                  aria-label={`查看 ${l.symbol} K 线`}
                >
                  {l.base}
                </button>
                <div className="w-24 shrink-0 text-right tabular-nums">
                  <div className="text-xs">{fmtPrice(l.price)}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {isSupport ? '支撑' : '压力'} {fmtPrice(level.price)}
                  </div>
                </div>
                <span
                  className={cn(
                    'w-16 shrink-0 text-right text-xs font-semibold tabular-nums',
                    isSupport ? 'text-up' : 'text-down',
                  )}
                >
                  {level.distancePct >= 0 ? '+' : ''}
                  {level.distancePct.toFixed(2)}%
                </span>
                <span
                  className="hidden w-10 shrink-0 items-center justify-end text-[10px] text-muted-foreground tabular-nums sm:flex"
                  title="该区域极值点数量（越多越强）"
                >
                  {level.touches} 点
                </span>
                <button
                  onClick={() => onTrade(l.symbol, tradeSide)}
                  className={cn(
                    'ml-auto shrink-0 rounded px-2 py-1 text-xs font-semibold transition-colors',
                    isSupport
                      ? 'bg-up/10 text-up hover:bg-up hover:text-background'
                      : 'bg-down/10 text-down hover:bg-down hover:text-background',
                  )}
                >
                  {isSupport ? '做多' : '做空'}
                </button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function MajorLevels({
  levels,
  loading,
  onTrade,
  onSelectSymbol,
}: {
  levels: SymbolLevels[];
  loading: boolean;
  onTrade: (symbol: string, side: 'LONG' | 'SHORT') => void;
  onSelectSymbol: (symbol: string) => void;
}) {
  return (
    <div className="space-y-4">
      <LevelCard
        kind="SUPPORT"
        levels={levels}
        loading={loading}
        onTrade={onTrade}
        onSelectSymbol={onSelectSymbol}
      />
      <LevelCard
        kind="RESIST"
        levels={levels}
        loading={loading}
        onTrade={onTrade}
        onSelectSymbol={onSelectSymbol}
      />
    </div>
  );
}
