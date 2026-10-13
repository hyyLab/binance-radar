'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useClosePosition } from '@/hooks/use-scanner';
import { PHASE_META, fmtRideDuration, fmtRideDurationShort } from '@/lib/ma7-ui';
import { fmtPrice, fmtVol } from '@/lib/format';
import type {
  Ma7Phase,
  Ma7Row,
  Ma7Status,
  Ma7TfState,
  PaperPositionDTO,
} from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { ArrowDownRight, ArrowUpRight, TrendingUp } from 'lucide-react';

type PhaseFilter = 'ALL' | Ma7Phase;
type DirFilter = 'ALL' | 'UP' | 'DOWN';
type SortMode = 'RIDE' | 'CHG';

const PHASE_CLS: Record<Ma7Phase, string> = {
  FRESH: 'bg-gold/15 text-gold',
  EARLY: 'bg-sky-500/15 text-sky-400',
  MATURE: 'bg-secondary text-muted-foreground',
};

/** 六周期成线状态徽章组 */
function TfBadges({ row }: { row: Ma7Row }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.tfStates.map((s: Ma7TfState) => (
        <span
          key={s.tf}
          title={
            s.dir
              ? `${s.tf} 沿 MA7 ${s.dir === 'UP' ? '上行' : '下行'} · 折算 ${s.rideMin} 分钟`
              : `${s.tf} 未成线`
          }
          className={cn(
            'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums',
            s.dir === 'UP'
              ? 'bg-up/15 text-up'
              : s.dir === 'DOWN'
                ? 'bg-down/15 text-down'
                : 'bg-secondary/60 text-muted-foreground/50',
          )}
        >
          {s.tf}
          {s.dir === 'UP' ? '↑' : s.dir === 'DOWN' ? '↓' : '·'}
        </span>
      ))}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: Ma7Phase }) {
  return (
    <span
      title={PHASE_META[phase].desc}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold',
        PHASE_CLS[phase],
      )}
    >
      {phase === 'FRESH' && <span className="h-1 w-1 animate-pulse rounded-full bg-current" />}
      {PHASE_META[phase].label}
    </span>
  );
}

export function Ma7Table({
  rows,
  status,
  loading,
  onSelect,
  onTrade,
  positions,
}: {
  rows: Ma7Row[];
  status?: Ma7Status;
  loading: boolean;
  onSelect: (symbol: string) => void;
  onTrade: (symbol: string, side: 'LONG' | 'SHORT') => void;
  positions: PaperPositionDTO[];
}) {
  const close = useClosePosition();
  const [phase, setPhase] = useState<PhaseFilter>('FRESH');
  const [dir, setDir] = useState<DirFilter>('ALL');
  const [sort, setSort] = useState<SortMode>('RIDE');

  const counts = useMemo(() => {
    const c: Record<PhaseFilter, number> = { ALL: rows.length, FRESH: 0, EARLY: 0, MATURE: 0 };
    for (const r of rows) c[r.phase]++;
    return c;
  }, [rows]);

  const view = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (phase !== 'ALL' && r.phase !== phase) return false;
      if (dir !== 'ALL' && r.dir !== dir) return false;
      return true;
    });
    if (sort === 'CHG') filtered.sort((a, b) => b.change24h - a.change24h);
    else filtered.sort((a, b) => a.maxRideMin - b.maxRideMin || b.aligned - a.aligned);
    return filtered;
  }, [rows, phase, dir, sort]);

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
      active
        ? 'border-gold/60 bg-gold/15 text-gold'
        : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground',
    );

  /** 操作按钮组：做多/做空（建议方向高亮）+ 加仓/平仓（无持仓禁用） */
  const renderActions = (row: Ma7Row) => {
    const side: 'LONG' | 'SHORT' = row.dir === 'UP' ? 'LONG' : 'SHORT';
    // 优先取与建议方向一致的持仓；对冲双仓时兜底任一
    const pos =
      positions.find((p) => p.symbol === row.symbol && p.side === side) ??
      positions.find((p) => p.symbol === row.symbol);
    const canAdd = !!pos && pos.side === side;
    const canClose = !!pos;
    return (
      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onTrade(row.symbol, 'LONG')}
          title="买入做多（回踩 MA7 顺势）"
          className={cn(
            'rounded px-2 py-1 text-xs font-semibold transition-colors',
            row.dir === 'UP'
              ? 'bg-up text-background hover:opacity-90'
              : 'bg-up/10 text-up hover:bg-up/20',
          )}
        >
          做多
        </button>
        <button
          onClick={() => onTrade(row.symbol, 'SHORT')}
          title="卖出做空（反抽 MA7 顺势）"
          className={cn(
            'rounded px-2 py-1 text-xs font-semibold transition-colors',
            row.dir === 'DOWN'
              ? 'bg-down text-background hover:opacity-90'
              : 'bg-down/10 text-down hover:bg-down/20',
          )}
        >
          做空
        </button>
        <button
          disabled={!canAdd}
          onClick={() => canAdd && onTrade(row.symbol, side)}
          title={canAdd ? '同方向追加保证金，自动合并仓位' : '该币种无同方向持仓'}
          className="rounded border border-gold/50 px-2 py-1 text-xs font-semibold text-gold transition-colors hover:bg-gold/15 disabled:cursor-not-allowed disabled:opacity-35"
        >
          加仓
        </button>
        <button
          disabled={!canClose}
          onClick={() => pos && close.mutate(pos.id)}
          title={canClose ? '按标记价市价平掉该币种持仓' : '该币种无持仓'}
          className="rounded border border-down/50 px-2 py-1 text-xs font-semibold text-down transition-colors hover:bg-down/15 disabled:cursor-not-allowed disabled:opacity-35"
        >
          平仓
        </button>
      </div>
    );
  };

  const renderKeyLevel = (row: Ma7Row, alignRight = false) => (
    <div className={cn(alignRight && 'text-right')}>
      <div
        className={cn(
          'text-xs font-semibold tabular-nums',
          row.dir === 'UP' ? 'text-up' : 'text-down',
        )}
      >
        {fmtPrice(row.keyLevel)}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {row.dir === 'UP' ? '支撑' : '压力'} · 主导 {row.leadTf}
      </div>
    </div>
  );

  const renderRide = (row: Ma7Row) => (
    <div className="flex items-center gap-1.5">
      <PhaseBadge phase={row.phase} />
      <span
        className="text-xs tabular-nums text-muted-foreground"
        title={`折算成线时长 ${fmtRideDuration(row.maxRideMin)} · 贴线 ${row.touches} 次`}
      >
        {fmtRideDurationShort(row.maxRideMin)}
      </span>
    </div>
  );

  return (
    <div className="rounded-lg border border-border/70 bg-card">
      {/* 头部：标题 + 状态 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <TrendingUp className="h-4 w-4 text-gold" />
          M(7) 沿线趋势 · 顺势交易
        </h3>
        <span className="hidden text-xs text-muted-foreground lg:inline">
          连续 ≥4 根收盘站上/下 MA7 + 均线同向倾斜 + 偏离 ≤7% · ≥2 周期成线上榜
        </span>
        {status?.scanning ? (
          <span className="flex items-center gap-1.5 text-xs text-gold">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
            重扫中…
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          覆盖 {status?.universe ?? 0} · 上榜 {view.length} · {status?.intervalSec ?? 60}s/轮
        </span>
      </div>

      {/* 过滤 + 排序 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-1.5" role="group" aria-label="阶段过滤">
          {(['ALL', 'FRESH', 'EARLY', 'MATURE'] as PhaseFilter[]).map((p) => (
            <button key={p} className={chip(phase === p)} onClick={() => setPhase(p)}>
              {p === 'ALL' ? '全部' : PHASE_META[p].label}
              <span className="ml-1 tabular-nums opacity-70">{counts[p]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="方向过滤">
          <button className={chip(dir === 'ALL')} onClick={() => setDir('ALL')}>
            多空
          </button>
          <button className={chip(dir === 'UP')} onClick={() => setDir('UP')}>
            <ArrowUpRight className="mr-0.5 inline h-3 w-3 text-up" />
            做多
          </button>
          <button className={chip(dir === 'DOWN')} onClick={() => setDir('DOWN')}>
            <ArrowDownRight className="mr-0.5 inline h-3 w-3 text-down" />
            做空
          </button>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="排序方式">
          <button className={chip(sort === 'RIDE')} onClick={() => setSort('RIDE')} title="折算成线时长升序">
            按启动时间
          </button>
          <button className={chip(sort === 'CHG')} onClick={() => setSort('CHG')} title="24h 涨跌幅降序">
            按 24h 涨跌
          </button>
        </div>
      </div>

      {/* 桌面表格 */}
      <div className="custom-scroll hidden max-h-[54vh] overflow-y-auto md:block">
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : view.length === 0 ? (
          <EmptyHint phase={phase} scanning={!!status?.scanning} onShowAll={() => setPhase('ALL')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-3 text-muted-foreground">#</TableHead>
                <TableHead className="text-muted-foreground">币对</TableHead>
                <TableHead className="text-right text-muted-foreground">24h 涨跌</TableHead>
                <TableHead className="text-muted-foreground">周期趋势</TableHead>
                <TableHead className="text-center text-muted-foreground">成线</TableHead>
                <TableHead className="text-right text-muted-foreground">关键位</TableHead>
                <TableHead className="text-muted-foreground">启动</TableHead>
                <TableHead className="pr-3 text-right text-muted-foreground">交易</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((row, i) => (
                <TableRow
                  key={row.symbol}
                  onClick={() => onSelect(row.symbol)}
                  className="cursor-pointer border-border/50"
                >
                  <TableCell className="pl-3 text-xs text-muted-foreground tabular-nums">
                    {i + 1}
                  </TableCell>
                  <TableCell>
                    <div className="font-semibold hover:text-gold">
                      {row.base}
                      <span className="text-[10px] font-normal text-muted-foreground">/USDT</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">
                      24h 额 {fmtVol(row.quoteVolume24h)}
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right text-xs font-semibold tabular-nums',
                      row.change24h >= 0 ? 'text-up' : 'text-down',
                    )}
                  >
                    {row.change24h >= 0 ? '+' : ''}
                    {row.change24h.toFixed(2)}%
                  </TableCell>
                  <TableCell>
                    <TfBadges row={row} />
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-bold tabular-nums">
                      {row.aligned}/6
                    </span>
                  </TableCell>
                  <TableCell
                    className="text-right"
                    title={
                      row.dir === 'UP'
                        ? '上涨趋势关键支撑：连续段内最近一次贴线未破的低点，跌破则趋势可能结束'
                        : '下跌趋势关键压力：连续段内最近一次贴线未破的高点，突破则趋势可能结束'
                    }
                  >
                    {renderKeyLevel(row, true)}
                  </TableCell>
                  <TableCell>{renderRide(row)}</TableCell>
                  <TableCell className="pr-3 text-right">{renderActions(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 移动端卡片 */}
      <div className="custom-scroll max-h-[60vh] overflow-y-auto md:hidden">
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : view.length === 0 ? (
          <EmptyHint phase={phase} scanning={!!status?.scanning} onShowAll={() => setPhase('ALL')} />
        ) : (
          view.map((row, i) => (
            <div
              key={row.symbol}
              className="border-b border-border/50 px-3 py-2.5 last:border-0 active:bg-secondary/30"
              onClick={() => onSelect(row.symbol)}
            >
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="shrink-0 text-sm font-semibold">{row.base}</span>
                <PhaseBadge phase={row.phase} />
                <span
                  className={cn(
                    'ml-auto shrink-0 text-xs font-semibold tabular-nums',
                    row.change24h >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {row.change24h >= 0 ? '+' : ''}
                  {row.change24h.toFixed(2)}%
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <TfBadges row={row} />
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                  成线 {row.aligned}/6
                </span>
                <span
                  className={cn(
                    'text-[11px] font-semibold tabular-nums',
                    row.dir === 'UP' ? 'text-up' : 'text-down',
                  )}
                >
                  {row.dir === 'UP' ? '支撑' : '压力'} {fmtPrice(row.keyLevel)}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {fmtRideDurationShort(row.maxRideMin)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">{renderActions(row)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EmptyHint({
  phase,
  scanning,
  onShowAll,
}: {
  phase: PhaseFilter;
  scanning: boolean;
  onShowAll: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-sm font-medium">
        {scanning ? '正在扫描六周期 MA7 沿线趋势…' : phase !== 'ALL' ? '该阶段暂无沿线趋势币种' : '暂无符合条件的 MA(7) 沿线趋势'}
      </div>
      <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
        成线规则：MA7 同向倾斜 + 最近连续 ≥4 根已收盘 K 线收盘站上/下 MA7 + 现价偏离 ≤7%。
        至少 2 个周期同向成线才会上榜，按「启动时间」升序展示最新鲜的信号。
        扫描范围：24h 成交额 Top100（已剔除股票 / 商品代币），每 60 秒自动重扫。
      </p>
      {phase !== 'ALL' && (
        <button
          onClick={onShowAll}
          className="rounded-full border border-gold/60 bg-gold/15 px-3 py-1 text-xs font-semibold text-gold"
        >
          查看全部阶段
        </button>
      )}
    </div>
  );
}
