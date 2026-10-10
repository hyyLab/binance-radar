'use client';

import { cn } from '@/lib/utils';
import { pctClass } from '@/lib/format';
import type { AnomalyType } from '@/lib/market/types';

/** 涨跌幅文本 */
export function Pct({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v == null || !Number.isFinite(v)) {
    return <span className={cn('text-muted-foreground tabular-nums', className)}>—</span>;
  }
  return (
    <span className={cn('tabular-nums font-medium', pctClass(v), className)}>
      {v > 0 ? '+' : ''}
      {v.toFixed(2)}%
    </span>
  );
}

/** 涨跌幅徽章 */
export function PctBadge({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v == null || !Number.isFinite(v)) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>;
  }
  const up = v > 0;
  const flat = v === 0;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums',
        flat ? 'bg-secondary text-muted-foreground' : up ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
        className,
      )}
    >
      {up ? '+' : ''}
      {v.toFixed(2)}%
    </span>
  );
}

/** 价格单元格：价格变化时红/绿闪烁（方向由服务端 tick 判定，key 重挂载重启动画） */
export function FlashPrice({
  value,
  dir,
  className,
  prefix,
}: {
  value: number;
  dir: 1 | -1 | 0;
  className?: string;
  prefix?: string;
}) {
  const flash = dir === 1 ? 'flash-up' : dir === -1 ? 'flash-down' : '';
  return (
    <span
      key={value}
      className={cn(
        'inline-block rounded px-1 tabular-nums font-medium',
        flash,
        className,
      )}
    >
      {prefix}
      {value.toLocaleString('en-US', { maximumFractionDigits: 8 })}
    </span>
  );
}

const ANOMALY_META: Record<
  AnomalyType,
  { label: string; cls: string; icon: '↗' | '↘' | '⚡' | '🚀' | '💥' }
> = {
  SPIKE_UP: { label: '急速拉升', cls: 'bg-up/15 text-up border-up/30', icon: '🚀' },
  SPIKE_DOWN: { label: '短时跳水', cls: 'bg-down/15 text-down border-down/30', icon: '💥' },
  VOLUME_SURGE: { label: '成交量激增', cls: 'bg-gold/15 text-gold border-gold/30', icon: '⚡' },
  BREAKOUT_HIGH: { label: '突破新高', cls: 'bg-up/15 text-up border-up/30', icon: '↗' },
  BREAKOUT_LOW: { label: '跌破新低', cls: 'bg-down/15 text-down border-down/30', icon: '↘' },
};

export function anomalyLabel(t: AnomalyType): string {
  return ANOMALY_META[t].label;
}

/** 异动类型徽章 */
export function TypeBadge({ type, major }: { type: AnomalyType; major?: boolean }) {
  const meta = ANOMALY_META[type];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        meta.cls,
      )}
    >
      <span aria-hidden>{meta.icon}</span>
      {meta.label}
      {major && (
        <span className="ml-0.5 rounded bg-foreground/80 px-1 text-[10px] font-bold text-background">
          强
        </span>
      )}
    </span>
  );
}
