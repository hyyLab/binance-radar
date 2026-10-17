'use client';

// ---------- 趋势跟踪面板（Universal Trend Engine + 生命周期 v2 展示） ----------
// 相位：观察中 / 候选↑↓ / 确认↑↓ / 结束待确认 / 已结束 / 数据不可用（Task 54 生命周期）
// 波动特征：ATR% / 已实现波动率状态 / 方向效率 ER / 15m 高周期过滤 / 入池通道
// 冲突展示：趋势方向与原异动方向相反时明确标红，不静默覆盖任何一方。
// 趋势评分为启发式证据分，不构成交易建议；自动模拟交易见独立页面（/trend-trading）。

import { fmtAgo, fmtPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTrendWatch } from '@/hooks/use-enhanced';
import type { TrendWatchRow } from '@/lib/market/trend-watch/types';
import type { TrendPhaseV2 } from '@/lib/market/trend-watch/signal';
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  Minus,
  TrendingUp,
} from 'lucide-react';

const PHASE_LABEL: Record<TrendPhaseV2, string> = {
  OBSERVING: '观察中',
  CANDIDATE_UP: '候选上涨',
  CANDIDATE_DOWN: '候选下跌',
  CONFIRMED_UP: '确认上涨',
  CONFIRMED_DOWN: '确认下跌',
  END_PENDING: '结束待确认',
  ENDED: '已结束',
  DATA_UNAVAILABLE: '数据不可用',
};

function phaseClass(p: TrendPhaseV2): string {
  if (p === 'CONFIRMED_UP') return 'bg-up/20 text-up';
  if (p === 'CONFIRMED_DOWN') return 'bg-down/20 text-down';
  if (p === 'CANDIDATE_UP') return 'bg-up/10 text-up/80';
  if (p === 'CANDIDATE_DOWN') return 'bg-down/10 text-down/80';
  if (p === 'END_PENDING' || p === 'DATA_UNAVAILABLE') return 'bg-gold/15 text-gold';
  return 'bg-secondary text-muted-foreground';
}

function PhaseBadge({ row }: { row: TrendWatchRow }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', phaseClass(row.phaseV2))}>
      {PHASE_LABEL[row.phaseV2]}
    </span>
  );
}

function DirIcon({ d }: { d: string }) {
  if (d === 'up') return <ArrowUpRight className="h-4 w-4 shrink-0 text-up" aria-label="上行" />;
  if (d === 'down') return <ArrowDownRight className="h-4 w-4 shrink-0 text-down" aria-label="下行" />;
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
  const vol = row.vol;
  const htf = row.htf15m;
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-2.5',
        row.phaseV2 === 'CONFIRMED_UP' || row.phaseV2 === 'CONFIRMED_DOWN'
          ? 'border-gold/50 shadow-[0_0_10px_-4px] shadow-gold/30'
          : row.phaseV2 === 'END_PENDING'
            ? 'border-gold/30'
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

      {/* 评分 + 确认计数 + 结束证据 */}
      <div className="mt-1.5 flex items-center gap-2">
        <ScoreBar score={row.score} />
        {row.phaseV2 === 'CANDIDATE_UP' || row.phaseV2 === 'CANDIDATE_DOWN' ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            确认 {row.consecutiveObservations}/3
          </span>
        ) : null}
        {row.phaseV2 === 'END_PENDING' && (
          <span className="text-[10px] font-semibold text-gold">
            结束证据 {row.endEvidenceBars}/3
          </span>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground" title="入池时间">
          {fmtAgo(row.addedAt)}入池
        </span>
      </div>

      {/* 评估依据 */}
      {row.reason && (
        <div className="mt-1 truncate text-[10px] text-muted-foreground/90" title={row.reason}>
          依据：{row.reason}
        </div>
      )}

      {/* 波动特征 + 高周期过滤（Task 54） */}
      {vol && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          <span title="ATR 占价比（波动幅度）">ATR {vol.atrPct.toFixed(2)}%</span>
          <span
            className={cn(
              'rounded px-1 py-0.5 font-semibold',
              vol.volRegime === 'EXTREME'
                ? 'bg-down/15 text-down'
                : vol.volRegime === 'HIGH'
                  ? 'bg-gold/15 text-gold'
                  : 'bg-secondary',
            )}
            title={`已实现波动率（日化）${vol.realizedVolPct.toFixed(1)}% · 历史分位 ${vol.volPercentile >= 0 ? (vol.volPercentile * 100).toFixed(0) + '%' : '样本不足'}`}
          >
            {vol.volRegime === 'EXTREME' ? '极端波动' : vol.volRegime === 'HIGH' ? '高波动' : '正常波动'}
          </span>
          <span title="方向效率（|净位移|/Σ|位移|，高=单边 低=震荡）">ER {vol.efficiencyRatio.toFixed(2)}</span>
          {htf && (
            <span
              className={cn(
                'rounded px-1 py-0.5',
                !htf.valid
                  ? 'bg-secondary text-muted-foreground/70'
                  : htf.dir === row.direction
                    ? 'bg-up/10 text-up/80'
                    : htf.dir !== 'flat'
                      ? 'bg-down/10 text-down/80'
                      : 'bg-secondary',
              )}
              title={
                htf.valid
                  ? `15m 趋势：${htf.dir}（${htf.bars} 根已收盘）`
                  : `15m 数据不足（${htf.bars}/16 根）——不作有效过滤，不冒充确认`
              }
            >
              15m {htf.valid ? (htf.dir === 'up' ? '↑' : htf.dir === 'down' ? '↓' : '→') : '数据不足'}
            </span>
          )}
          {row.entryChannel !== 'anomaly' && (
            <span className="rounded bg-secondary px-1 py-0.5 text-muted-foreground/70" title="入池通道">
              {row.entryChannel === 'probe' ? '探针' : '恢复'}
            </span>
          )}
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
        {row.phaseV2 === 'DATA_UNAVAILABLE' && row.dataUnavailableReason && (
          <span className="text-gold">{row.dataUnavailableReason}（暂停判断，不误判趋势结束）</span>
        )}
        {!row.dataMissing && row.stale && row.phaseV2 !== 'DATA_UNAVAILABLE' && (
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
            {stats.endPending > 0 && (
              <span>
                结束待确认 <span className="font-semibold text-gold">{stats.endPending}</span>
              </span>
            )}
            <span className="hidden lg:inline">K 线 {stats.klineReqs} req</span>
            <span className="hidden lg:inline">探针 {stats.probeReqs} req</span>
            {stats.restoredFromDb > 0 && (
              <span className="hidden lg:inline text-muted-foreground/70">重启恢复 {stats.restoredFromDb}</span>
            )}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          1m 主周期 + 15m 过滤 · 异动+主动探针双通道 · 评分未经回测校准，非交易信号 · 自动模拟盘见独立页面
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
          暂无趋势候选 · 显著异动（P1/P2 等级、证据充分、成交额达标）与主动探针发现的「形成中趋势」将自动进入观察池，
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
