'use client';

// ---------- 趋势跟踪面板（Universal Trend Engine 集成展示） ----------
// 区分：观察中（idle）/ 候选趋势（candidate）/ 已确认趋势（confirmed）
//       上行（up）/ 下行（down）/ 无明确方向（flat）
// 冲突展示：趋势方向与原异动方向相反时明确标红，不静默覆盖任何一方。
// 趋势评分为启发式证据分，不构成交易建议；本面板不提供自动交易。

import { fmtAgo, fmtPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTrendWatch } from '@/hooks/use-enhanced';
import type { TrendWatchRow } from '@/lib/market/trend-watch/types';
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  Minus,
  TrendingUp,
} from 'lucide-react';

const PHASE_LABEL: Record<TrendWatchRow['phase'], string> = {
  idle: '观察中',
  candidate: '候选趋势',
  confirmed: '已确认趋势',
};

function PhaseBadge({ row }: { row: TrendWatchRow }) {
  const { phase, direction } = row;
  if (phase === 'confirmed') {
    const up = direction === 'up';
    return (
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-bold',
          up ? 'bg-up/20 text-up' : direction === 'down' ? 'bg-down/20 text-down' : 'bg-secondary text-muted-foreground',
        )}
      >
        {PHASE_LABEL[phase]}
      </span>
    );
  }
  if (phase === 'candidate') {
    return (
      <span className="rounded bg-gold/15 px-1.5 py-0.5 text-[10px] font-bold text-gold">
        {PHASE_LABEL[phase]}
      </span>
    );
  }
  return (
    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      {PHASE_LABEL[phase]}
    </span>
  );
}

function DirIcon({ d }: { d: TrendWatchRow['direction'] }) {
  if (d === 'up')
    return <ArrowUpRight className="h-4 w-4 shrink-0 text-up" aria-label="上行" />;
  if (d === 'down')
    return <ArrowDownRight className="h-4 w-4 shrink-0 text-down" aria-label="下行" />;
  return <Minus className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="无明确方向" />;
}

function ScoreBar({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-1.5" title="UTE 趋势评分：启发式证据分（0-100），非概率、非盈利承诺">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full',
            clamped >= 60 ? 'bg-gold' : clamped >= 35 ? 'bg-gold/60' : 'bg-muted-foreground/50',
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {clamped}
      </span>
    </div>
  );
}

function TrendCard({
  row,
  onSelectSymbol,
}: {
  row: TrendWatchRow;
  onSelectSymbol: (symbol: string) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-2.5',
        row.phase === 'confirmed'
          ? 'border-gold/50 shadow-[0_0_10px_-4px] shadow-gold/30'
          : 'border-border/60',
      )}
    >
      {/* 头行：相位 + 标的 + 方向 + 价格 */}
      <div className="flex items-center gap-1.5">
        <PhaseBadge row={row} />
        <button
          className="font-mono text-xs font-bold hover:text-gold"
          onClick={() => onSelectSymbol(row.symbol)}
          title="查看 K 线"
        >
          {row.base}
          <span className="text-muted-foreground">/USDT</span>
        </button>
        <DirIcon d={row.direction} />
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
          {row.price != null ? fmtPrice(row.price) : '—'}
        </span>
      </div>

      {/* 评分 + 连续确认 */}
      <div className="mt-1.5 flex items-center gap-2">
        <ScoreBar score={row.score} />
        <span className="text-[10px] tabular-nums text-muted-foreground">
          确认 {row.consecutiveObservations}/3
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground" title="入池时间">
          {fmtAgo(row.addedAt)}入池
        </span>
      </div>

      {/* 评估依据（UTE reason） */}
      {row.reason && (
        <div className="mt-1 truncate text-[10px] text-muted-foreground/90" title={row.reason}>
          依据：{row.reason}
        </div>
      )}

      {/* 异动上下文 + 方向冲突展示 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
        {row.anomalyDir ? (
          <span className="text-muted-foreground">
            异动{' '}
            <span className={cn('font-semibold', row.anomalyDir === 'UP' ? 'text-up' : 'text-down')}>
              {row.anomalyDir === 'UP' ? '↑' : '↓'}
            </span>{' '}
            {row.anomalyLevel}
            {row.anomalyPriority ? `·${row.anomalyPriority}` : ''}
            {row.anomalyActive ? ' · 活跃中' : ` · ${fmtAgo(row.lastAnomalyAt)}`}
          </span>
        ) : (
          <span className="text-muted-foreground">无未过期异动上下文</span>
        )}
        {row.conflict && (
          <span className="inline-flex items-center gap-0.5 rounded bg-down/10 px-1 py-0.5 font-semibold text-down ring-1 ring-down/30">
            <CircleAlert className="h-3 w-3" />
            方向冲突：异动 {row.anomalyDir} vs 趋势 {row.direction === 'up' ? 'up' : 'down'}
          </span>
        )}
        {row.dataMissing && (
          <span className="text-gold">数据缺失（行情延迟/K线不足）</span>
        )}
        {!row.dataMissing && row.stale && (
          <span className="text-gold" title={`最新收盘 K 线 ${row.lastBarTime ? fmtAgo(row.lastBarTime + 60_000) : '—'}`}>
            K 线过期
          </span>
        )}
      </div>
    </div>
  );
}

export function TrendPanel({ onSelectSymbol }: { onSelectSymbol: (symbol: string) => void }) {
  const { data, isLoading, isError } = useTrendWatch();
  const rows = data?.pool ?? [];
  const stats = data?.stats;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TrendingUp className="h-4 w-4 text-gold" />
        <h2 className="text-sm font-bold sm:text-base">趋势跟踪</h2>
        {stats && (
          <span className="flex flex-wrap items-center gap-x-3 text-xs tabular-nums text-muted-foreground">
            <span>
              池 <span className="font-semibold text-foreground">{stats.poolSize}</span>/{stats.maxPoolSize}
            </span>
            <span>
              已确认 <span className="font-semibold text-gold">{stats.confirmed}</span>
            </span>
            <span>
              候选 <span className="font-semibold text-foreground">{stats.candidate}</span>
            </span>
            <span className="hidden lg:inline">K 线 {stats.klineReqs} req</span>
            {stats.restoredFromDb > 0 && (
              <span className="hidden lg:inline text-muted-foreground/70">重启恢复 {stats.restoredFromDb}</span>
            )}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          1m 周期 · 约 60s 刷新 · 仅评分配额内候选，不做全市场扫描 · 评分未经回测校准，非交易信号
        </span>
      </div>

      {isLoading && (
        <div className="rounded-lg border border-border/70 bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          趋势服务启动中（从数据库恢复候选池与确认历史）…
        </div>
      )}
      {isError && (
        <div className="rounded-lg border border-down/40 bg-down/10 px-4 py-6 text-center text-sm text-down">
          趋势数据加载失败，稍后自动重试
        </div>
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <div className="rounded-lg border border-border/70 bg-card px-4 py-6 text-center text-xs text-muted-foreground">
          暂无趋势候选 · 显著异动（P1/P2 等级、证据充分、成交额达标）的合约将自动进入观察池，
          由 Universal Trend Engine 按 1m K 线独立评估趋势方向与强度
        </div>
      )}
      {!isLoading && !isError && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <TrendCard key={row.symbol} row={row} onSelectSymbol={onSelectSymbol} />
          ))}
        </div>
      )}
    </div>
  );
}
