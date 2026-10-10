'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtMult, fmtPrice, fmtTime, fmtVol } from '@/lib/format';
import type { AnomalyEventDTO, AnomalyType } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { Pct, PctBadge, TypeBadge } from './shared';
import { Radar } from 'lucide-react';

type FilterKey = 'ALL' | 'SPIKE' | 'VOLUME_SURGE' | 'BREAKOUT';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'ALL', label: '全部异动' },
  { key: 'SPIKE', label: '拉升/跳水' },
  { key: 'VOLUME_SURGE', label: '成交量激增' },
  { key: 'BREAKOUT', label: '新高/新低' },
];

function matchFilter(ev: AnomalyEventDTO, f: FilterKey): boolean {
  if (f === 'ALL') return true;
  if (f === 'SPIKE') return ev.type === 'SPIKE_UP' || ev.type === 'SPIKE_DOWN';
  if (f === 'BREAKOUT') return ev.type === 'BREAKOUT_HIGH' || ev.type === 'BREAKOUT_LOW';
  return ev.type === f;
}

export function AnomalyFeed({
  events,
  loading,
  symbolsTracked,
  onSelect,
}: {
  events: AnomalyEventDTO[];
  loading: boolean;
  symbolsTracked: number;
  onSelect: (s: string) => void;
}) {
  const [filter, setFilter] = useState<FilterKey>('ALL');

  const filtered = useMemo(() => events.filter((e) => matchFilter(e, filter)), [events, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="异动类型过滤">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              filter === f.key
                ? 'border-gold/60 bg-gold/15 text-gold'
                : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
            {f.key !== 'ALL' && (
              <span className="ml-1 tabular-nums opacity-70">
                {events.filter((e) => matchFilter(e, f.key)).length}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          共 {filtered.length} 条记录（保留 48 小时内）
        </span>
      </div>

      <div className="custom-scroll max-h-[58vh] overflow-y-auto rounded-lg border border-border/70 bg-card">
        {loading && events.length === 0 && (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <Radar className="h-10 w-10 animate-pulse text-gold/60" />
            <div className="text-sm font-medium">雷达正在扫描 {symbolsTracked} 个交易对…</div>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              系统实时监测短时拉升/跳水（1 分钟 ≥ 1%、5 分钟 ≥ 2%）、成交量激增（1 分钟成交额达 20
              分钟均值 6 倍以上）以及突破 24h 新高/新低。
              加密市场 24 小时波动活跃，通常几分钟内就会出现首个异动信号。
            </p>
          </div>
        )}

        {filtered.map((ev) => (
          <div
            key={ev.id}
            className="flex items-start gap-2 border-b border-border/50 px-3 py-2.5 transition-colors last:border-0 hover:bg-secondary/40 sm:gap-3"
          >
            <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
              {fmtTime(ev.createdAt)}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex shrink-0 items-center gap-2">
                <TypeBadge type={ev.type} major={ev.severity === 'MAJOR'} />
                <button
                  onClick={() => onSelect(ev.symbol)}
                  className="shrink-0 font-semibold hover:text-gold"
                  aria-label={`查看 ${ev.symbol} 详情`}
                >
                  {ev.base}
                  <span className="text-[10px] font-normal text-muted-foreground">/USDT</span>
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{ev.detail}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                  <span>
                    触发价 <span className="text-foreground">{fmtPrice(ev.price)}</span>
                  </span>
                  <span>
                    窗口涨跌 <Pct v={ev.changePct} className="text-xs" />
                  </span>
                  {ev.volumeMultiple > 0 && (
                    <span>
                      量比 <span className="font-semibold text-gold">{fmtMult(ev.volumeMultiple)}</span>
                    </span>
                  )}
                  {ev.quoteVolume1m > 0 && <span>1 分钟额 {fmtVol(ev.quoteVolume1m)} USDT</span>}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        · 同一币种同类型异动 5 分钟内不重复告警；「强」标记表示幅度或量能达到更高等级。
      </p>
    </div>
  );
}
