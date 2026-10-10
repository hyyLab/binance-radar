'use client';

import { useAnomalies } from '@/hooks/use-market';
import { fmtMult, fmtPrice, fmtTime, fmtVol } from '@/lib/format';
import type { AnomalyEventDTO } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { TypeBadge } from '@/components/market/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowDownRight, ArrowUpRight, Zap } from 'lucide-react';

/** 按异动类型给出建议交易方向：拉升高位顺势做多 / 跳水破位顺势做空 / 放量按攻防方向 */
function suggest(ev: AnomalyEventDTO): { side: 'LONG' | 'SHORT'; why: string } {
  switch (ev.type) {
    case 'SPIKE_UP':
      return { side: 'LONG', why: '短时急拉 · 动量顺势做多' };
    case 'SPIKE_DOWN':
      return { side: 'SHORT', why: '短时急挫 · 动量顺势做空' };
    case 'BREAKOUT_HIGH':
      return { side: 'LONG', why: '突破 24h 新高 · 破位顺势做多' };
    case 'BREAKOUT_LOW':
      return { side: 'SHORT', why: '跌破 24h 新低 · 破位顺势做空' };
    case 'VOLUME_SURGE':
      return ev.changePct >= 0
        ? { side: 'LONG', why: '放量上攻 · 量能顺势做多' }
        : { side: 'SHORT', why: '放量下杀 · 量能顺势做空' };
  }
}

export function AnomalyMonitor({
  onTrade,
  onSelectSymbol,
}: {
  onTrade: (symbol: string, side: 'LONG' | 'SHORT') => void;
  onSelectSymbol: (symbol: string) => void;
}) {
  const { data, isLoading } = useAnomalies();
  const events = (data?.data ?? []).slice(0, 30);

  return (
    <div className="rounded-lg border border-border/70 bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <Zap className="h-4 w-4 text-gold" />
          异动监控 · 一键交易
        </h3>
        <span className="text-xs text-muted-foreground">
          按当前异动给出建议方向（拉升高位顺势做多 / 跳水破位顺势做空），可直接模拟开仓
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          最近 {events.length} 条 · 5 秒刷新
        </span>
      </div>

      <div className="custom-scroll max-h-[42vh] overflow-y-auto">
        {isLoading && events.length === 0 && (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {!isLoading && events.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Zap className="h-8 w-8 animate-pulse text-gold/60" />
            <div className="text-sm font-medium">暂无异动信号</div>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              系统正在监测 1 分钟 ≥1%、5 分钟 ≥2% 的拉升/跳水，量比 ≥6
              倍的放量，以及突破 24h 新高/新低。加密市场波动活跃，通常几分钟内就会出现首个异动。
            </p>
          </div>
        )}

        {events.map((ev) => {
          const sug = suggest(ev);
          const isLong = sug.side === 'LONG';
          return (
            <div
              key={ev.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/50 px-4 py-2.5 last:border-0 hover:bg-secondary/30"
            >
              <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">
                {fmtTime(ev.createdAt)}
              </span>

              <TypeBadge type={ev.type} major={ev.severity === 'MAJOR'} />

              <button
                onClick={() => onSelectSymbol(ev.symbol)}
                className="w-24 shrink-0 text-left font-semibold hover:text-gold"
                aria-label={`查看 ${ev.symbol} K 线`}
              >
                {ev.base}
                <span className="text-[10px] font-normal text-muted-foreground">/USDT</span>
              </button>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{ev.detail}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                  <span>
                    触发价 <span className="text-foreground">{fmtPrice(ev.price)}</span>
                  </span>
                  {ev.volumeMultiple > 0 && (
                    <span>
                      量比 <span className="font-semibold text-gold">{fmtMult(ev.volumeMultiple)}</span>
                    </span>
                  )}
                  {ev.quoteVolume1m > 0 && <span>1 分钟额 {fmtVol(ev.quoteVolume1m)} USDT</span>}
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-semibold',
                      isLong
                        ? 'border-up/30 bg-up/10 text-up'
                        : 'border-down/30 bg-down/10 text-down',
                    )}
                  >
                    {isLong ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" />
                    )}
                    建议做{isLong ? '多' : '空'} · {sug.why}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => onTrade(ev.symbol, 'LONG')}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                    isLong
                      ? 'bg-up text-background hover:opacity-90'
                      : 'bg-up/10 text-up hover:bg-up/20',
                  )}
                >
                  买入做多
                </button>
                <button
                  onClick={() => onTrade(ev.symbol, 'SHORT')}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                    !isLong
                      ? 'bg-down text-background hover:opacity-90'
                      : 'bg-down/10 text-down hover:bg-down/20',
                  )}
                >
                  卖出做空
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
