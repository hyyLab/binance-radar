'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtPrice, fmtVol } from '@/lib/format';
import type { MaSignal } from '@/lib/market/indicators';
import { cn } from '@/lib/utils';
import { ArrowDownRight, ArrowUpRight, Star } from 'lucide-react';

type SideFilter = 'ALL' | 'LONG' | 'SHORT';
type TfFilter = 'ALL' | '3m' | '5m' | '15m';

function ScoreStars({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`信号强度 ${score}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            'h-3 w-3',
            i < score ? 'fill-gold text-gold' : 'text-muted-foreground/30',
          )}
        />
      ))}
    </span>
  );
}

export function SignalList({
  signals,
  loading,
  scanning,
  onTrade,
  onSelectSymbol,
}: {
  signals: MaSignal[];
  loading: boolean;
  scanning: boolean;
  onTrade: (symbol: string, side: 'LONG' | 'SHORT') => void;
  onSelectSymbol: (symbol: string) => void;
}) {
  const [side, setSide] = useState<SideFilter>('ALL');
  const [tf, setTf] = useState<TfFilter>('ALL');

  const filtered = useMemo(
    () =>
      signals.filter((s) => {
        if (side !== 'ALL') {
          if (side === 'LONG' && s.type !== 'LONG_MA_SUPPORT') return false;
          if (side === 'SHORT' && s.type !== 'SHORT_MA_RESIST') return false;
        }
        if (tf !== 'ALL' && s.tf !== tf) return false;
        return true;
      }),
    [signals, side, tf],
  );

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
      active
        ? 'border-gold/60 bg-gold/15 text-gold'
        : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground',
    );

  return (
    <div className="rounded-lg border border-border/70 bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
        <h3 className="mr-1 text-sm font-bold">均线支撑位机会</h3>
        <div className="flex items-center gap-1.5" role="group" aria-label="方向过滤">
          <button className={chip(side === 'ALL')} onClick={() => setSide('ALL')}>
            全部
          </button>
          <button className={chip(side === 'LONG')} onClick={() => setSide('LONG')}>
            <ArrowUpRight className="mr-0.5 inline h-3 w-3 text-up" />
            做多机会
          </button>
          <button className={chip(side === 'SHORT')} onClick={() => setSide('SHORT')}>
            <ArrowDownRight className="mr-0.5 inline h-3 w-3 text-down" />
            做空机会
          </button>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="周期过滤">
          {(['ALL', '3m', '5m', '15m'] as TfFilter[]).map((t) => (
            <button key={t} className={chip(tf === t)} onClick={() => setTf(t)}>
              {t === 'ALL' ? '全周期' : t}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {filtered.length} 个机会
        </span>
      </div>

      <div className="custom-scroll max-h-[52vh] overflow-y-auto">
        {loading && signals.length === 0 && (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <div className="text-sm font-medium">
              {scanning ? '正在扫描交易最活跃 Top20 虚拟币…' : '暂无符合条件的均线机会'}
            </div>
            <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
              扫描范围：24h 成交额最活跃的前 20 个虚拟币（代币化股票、ETF、贵金属商品代币与稳定币已剔除）。
              趋势方向明确时捕捉回踩均线企稳（做多）或反抽受阻（做空）形态，评分 ≥3
              星才展示，每 2 分钟自动重扫。
            </p>
          </div>
        )}

        {filtered.map((s) => {
          const isLong = s.type === 'LONG_MA_SUPPORT';
          return (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/50 px-4 py-2.5 last:border-0 hover:bg-secondary/30"
            >
              <div className="flex w-14 shrink-0 flex-col items-start">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-bold text-foreground">
                  {s.tf}
                </span>
                <span
                  className={cn(
                    'mt-0.5 text-[10px] font-semibold',
                    isLong ? 'text-up' : 'text-down',
                  )}
                >
                  {isLong ? '做多' : '做空'}
                </span>
              </div>

              <button
                onClick={() => onSelectSymbol(s.symbol)}
                className="w-24 shrink-0 text-left font-semibold hover:text-gold"
                aria-label={`查看 ${s.symbol} K 线`}
              >
                {s.base}
                <span className="text-[10px] font-normal text-muted-foreground">/USDT</span>
              </button>

              <div className="w-24 shrink-0">
                <div className="text-sm font-medium tabular-nums">{fmtPrice(s.price)}</div>
                <div
                  className={cn(
                    'text-[10px] tabular-nums',
                    s.change24h >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  24h {s.change24h >= 0 ? '+' : ''}
                  {s.change24h.toFixed(2)}%
                </div>
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className={isLong ? 'text-up' : 'text-down'}>
                    {isLong ? '回踩' : '反抽'}
                  </span>{' '}
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-bold">
                    {s.maName}
                  </span>
                  <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                    {fmtPrice(s.maValue)}（距 {s.distancePct >= 0 ? '+' : ''}
                    {s.distancePct.toFixed(2)}%）
                  </span>
                  {s.volumeBoost && (
                    <span className="ml-1.5 rounded bg-gold/15 px-1 py-0.5 text-[10px] font-semibold text-gold">
                      放量
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {s.alignment === 'BULL'
                    ? '多头排列'
                    : s.alignment === 'BEAR'
                      ? '空头排列'
                      : '均线交织'}
                  · 24h 额 {fmtVol(s.quoteVolume24h)} USDT
                </div>
              </div>

              <ScoreStars score={s.score} />

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => onTrade(s.symbol, 'LONG')}
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
                  onClick={() => onTrade(s.symbol, 'SHORT')}
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
