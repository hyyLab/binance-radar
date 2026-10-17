'use client';

// ---------- 趋势自动模拟交易页（Task 54 §5） ----------
// 与手动模拟盘完全隔离（独立账户 trend-auto-v1）：总览 + 当前持仓 + 历史明细 + 控制。
// ⚠️ 纯模拟交易；趋势评分为启发式证据分；趋势确认 ≠ 买卖指令；强平如实统计。

import { useState } from 'react';
import {
  Bot,
  ChevronDown,
  CircleAlert,
  History,
  Pause,
  Play,
  Square,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtAgo, fmtPct, fmtPrice, fmtTime } from '@/lib/format';
import {
  useTrendTradeControl,
  useTrendTradeHistory,
  useTrendTrading,
  type TrendPositionRow,
  type TrendTradeRow,
} from '@/hooks/use-trend-trade';

const EXIT_REASON_LABEL: Record<string, string> = {
  TREND_ENDED: '趋势结束',
  REVERSE_CONFIRMED: '反向确认',
  LIQUIDATED: '强平',
  MANUAL: '人工平仓',
};

const PHASE_V2_LABEL: Record<string, string> = {
  OBSERVING: '观察中',
  CANDIDATE_UP: '候选上涨',
  CANDIDATE_DOWN: '候选下跌',
  CONFIRMED_UP: '确认上涨',
  CONFIRMED_DOWN: '确认下跌',
  END_PENDING: '结束待确认',
  ENDED: '已结束',
  DATA_UNAVAILABLE: '数据不可用',
  CONFIRMED_RESTORED: '重启恢复',
};

function pnlClass(v: number | null | undefined): string {
  if (v == null || v === 0) return 'text-muted-foreground';
  return v > 0 ? 'text-up' : 'text-down';
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-mono text-sm font-bold tabular-nums', cls)}>{value}</div>
    </div>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  if (mode === 'RUNNING')
    return <span className="rounded bg-up/15 px-2 py-0.5 text-[11px] font-bold text-up">运行中</span>;
  if (mode === 'PAUSED')
    return <span className="rounded bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-gold">已暂停（持仓仍受监控）</span>;
  return <span className="rounded bg-secondary px-2 py-0.5 text-[11px] font-bold text-muted-foreground">已停止</span>;
}

// ============ 当前持仓卡片 ============

function PositionCard({
  p,
  onClose,
  busy,
}: {
  p: TrendPositionRow;
  onClose: (positionId: string) => void;
  busy: boolean;
}) {
  const long = p.side === 'LONG';
  return (
    <div className={cn('rounded-lg border bg-card p-2.5', long ? 'border-up/30' : 'border-down/30')}>
      <div className="flex items-center gap-1.5">
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', long ? 'bg-up/20 text-up' : 'bg-down/20 text-down')}>
          {long ? '做多' : '做空'} {p.leverage}x
        </span>
        <span className="font-mono text-xs font-bold">{p.base}<span className="text-muted-foreground">/USDT</span></span>
        <span className="ml-auto font-mono text-xs tabular-nums">{fmtPrice(p.markPrice)}</span>
        <button
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-down disabled:opacity-40"
          disabled={busy}
          onClick={() => onClose(p.positionId)}
        >
          平仓
        </button>
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground sm:grid-cols-4">
        <span>开仓 {fmtPrice(p.entryPrice)}</span>
        <span>保证金 {p.margin.toFixed(2)}</span>
        <span>名义 {p.notional.toFixed(1)}</span>
        <span>持仓 {p.holdMinutes}min</span>
        <span>强平价 {fmtPrice(p.liqPrice)}</span>
        <span>预计平仓费 {p.estCloseFee.toFixed(3)}</span>
        <span className={pnlClass(p.unrealizedGross)}>毛盈亏 {p.unrealizedGross.toFixed(3)}</span>
        <span className={pnlClass(p.netEst)}>净估算 {p.netEst.toFixed(3)}</span>
      </div>

      {/* 趋势关联（消费统一信号，与趋势面板同源） */}
      {p.trend ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
          <span
            className={cn(
              'rounded px-1 py-0.5 font-semibold',
              p.trend.phase === 'CONFIRMED_UP'
                ? 'bg-up/15 text-up'
                : p.trend.phase === 'CONFIRMED_DOWN'
                  ? 'bg-down/15 text-down'
                  : p.trend.phase === 'END_PENDING'
                    ? 'bg-gold/15 text-gold'
                    : 'bg-secondary text-muted-foreground',
            )}
          >
            {PHASE_V2_LABEL[p.trend.phase] ?? p.trend.phase} · {p.trend.score}分
          </span>
          {p.trend.phase === 'END_PENDING' && (
            <span className="text-gold">结束确认 {p.trend.endEvidenceBars}/3 根</span>
          )}
          {p.trend.htfAgree === false && <span className="text-gold">15m 方向不一致</span>}
          {p.trend.conflict && <span className="text-down">方向冲突</span>}
          {!p.trend.dataFresh && <span className="text-gold">数据不可用（不开新仓、不误判结束）</span>}
          <span className="truncate text-muted-foreground/80" title={p.trend.reason}>{p.trend.reason}</span>
        </div>
      ) : (
        <div className="mt-1.5 text-[10px] text-muted-foreground">趋势信号缺失（重启恢复/已退池，仅强平与人工管理）</div>
      )}
      {p.waitingEndConfirm && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-gold">
          <CircleAlert className="h-3 w-3" /> 持仓等待趋势结束确认（连续收盘 K 线判定，防插针误离场）
        </div>
      )}
    </div>
  );
}

// ============ 历史明细行 ============

function TradeRow({ t, onDetail }: { t: TrendTradeRow; onDetail: (id: string) => void }) {
  const exitLabel = EXIT_REASON_LABEL[t.exitReason ?? ''] ?? (t.exitReason ?? '—');
  const net = t.netPnlWithSlip;
  return (
    <button
      onClick={() => onDetail(t.positionId)}
      className="grid w-full grid-cols-[64px_60px_44px_1fr_1fr_70px_90px] items-center gap-1 rounded px-2 py-1 text-left text-[11px] tabular-nums hover:bg-secondary/40 sm:grid-cols-[80px_64px_52px_1fr_1fr_76px_96px]"
      title="点击查看开仓依据与趋势变化详情"
    >
      <span className="truncate text-muted-foreground">{fmtTime(t.closedAt)}</span>
      <span className="truncate font-mono font-semibold">{t.base}</span>
      <span className={cn('font-bold', t.side === 'LONG' ? 'text-up' : 'text-down')}>
        {t.side === 'LONG' ? '多' : '空'}
      </span>
      <span className="truncate text-muted-foreground">
        {fmtPrice(t.entryPrice)} → {t.exitPrice != null ? fmtPrice(t.exitPrice) : '—'}
      </span>
      <span className="truncate text-muted-foreground">
        费 {(t.openFee + t.closeFee).toFixed(3)} · 滑 {t.slippageEst.toFixed(3)}
      </span>
      <span className={cn('truncate font-semibold', exitLabel === '强平' ? 'text-down' : 'text-muted-foreground')}>
        {exitLabel}
      </span>
      <span className={cn('text-right font-bold', pnlClass(net))}>
        {net != null ? net.toFixed(3) : '—'}
      </span>
    </button>
  );
}

// ============ 单笔详情（决策链还原） ============

interface TradeDetail {
  meta: {
    trendCycleId: string;
    trendPhaseAtOpen: string;
    scoreAtOpen: number;
    signalAtOpen: string;
    exitSignalJson: string | null;
    exitReason: string | null;
  };
  position: {
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice: number | null;
    openFee: number;
    closeFee: number;
    pnl: number | null;
    openedAt: string;
    closedAt: string | null;
  } | null;
  decisions: { id: string; action: string; detail: string; createdAt: number }[];
}

// ============ 主视图 ============

export function TrendTradeView() {
  const { data, isLoading, isError } = useTrendTrading();
  const control = useTrendTradeControl();
  const [filterSymbol, setFilterSymbol] = useState('');
  const [sort, setSort] = useState<'time' | 'pnl'>('time');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const history = useTrendTradeHistory(filterSymbol, sort, order);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TradeDetail | null>(null);

  const mode = data?.mode ?? 'RUNNING';
  const busy = control.isPending;

  const act = (action: string, positionId?: string) =>
    control.mutate(
      { action, positionId },
      {
        onSuccess: (r) => {
          if (!r.ok && r.error) window.alert(r.error);
        },
        onError: (e) => window.alert(`操作失败：${e.message}`),
      },
    );

  const openDetail = async (positionId: string) => {
    if (detailId === positionId) {
      setDetailId(null);
      setDetail(null);
      return;
    }
    setDetailId(positionId);
    setDetail(null);
    try {
      const res = await fetch(`/api/trend-trading/trades?positionId=${positionId}`, { cache: 'no-store' });
      const j = (await res.json()) as { ok: boolean; detail?: TradeDetail };
      setDetail(j.ok && j.detail ? j.detail : null);
    } catch {
      setDetail(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* 头部：标题 + 模式 + 控制 */}
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-4 w-4 text-gold" />
        <h1 className="text-sm font-bold sm:text-base">趋势自动模拟交易</h1>
        <ModeBadge mode={mode} />
        <span className="hidden text-[10px] text-muted-foreground sm:inline">
          账户 {data?.config.accountName ?? 'trend-auto-v1'} · 初始 {data?.config.initialCapital ?? '—'} USDT ·{' '}
          {((data?.config.marginRatio ?? 0.2) * 100).toFixed(0)}% 权益/笔 · {data?.config.leverage ?? 20}x · 最多{' '}
          {data?.config.maxPositions ?? 4} 仓 · 无固定止盈止损（趋势结束离场）
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {mode === 'RUNNING' ? (
            <button
              className="inline-flex items-center gap-1 rounded border border-gold/50 px-2 py-1 text-[11px] font-semibold text-gold hover:bg-gold/10 disabled:opacity-40"
              disabled={busy}
              onClick={() => act('pause')}
              title="暂停新开仓；现有持仓继续监控"
            >
              <Pause className="h-3 w-3" /> 暂停开仓
            </button>
          ) : (
            <button
              className="inline-flex items-center gap-1 rounded border border-up/50 px-2 py-1 text-[11px] font-semibold text-up hover:bg-up/10 disabled:opacity-40"
              disabled={busy}
              onClick={() => act('resume')}
            >
              <Play className="h-3 w-3" /> 恢复交易
            </button>
          )}
          <button
            className="inline-flex items-center gap-1 rounded border border-down/50 px-2 py-1 text-[11px] font-semibold text-down hover:bg-down/10 disabled:opacity-40"
            disabled={busy || (data?.positions.length ?? 0) === 0}
            onClick={() => {
              if (window.confirm('确认按标记价市价平掉全部自动持仓？')) act('closeAll');
            }}
            title="全部平仓（不影响运行模式）"
          >
            <Square className="h-3 w-3" /> 全部平仓
          </button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground/80">
        ⚠️ 纯模拟交易，不接入真实下单。趋势评分为启发式证据分（未经回放校准，非胜率/概率）；趋势确认 ≠ 买卖指令；强平为杠杆模拟执行结果，如实计入统计。
        {data && !data.service.on && <span className="ml-2 text-gold">服务尚未运行（访问本页自动拉起）</span>}
        {data?.service.lastError && <span className="ml-2 text-down">最近错误：{data.service.lastError}</span>}
      </div>

      {isLoading && (
        <div className="rounded-lg border border-border/70 bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          正在连接趋势自动交易服务（从数据库恢复持仓关联）…
        </div>
      )}
      {isError && (
        <div className="rounded-lg border border-down/40 bg-down/10 px-4 py-8 text-center text-sm text-down">
          服务加载失败，稍后自动重试
        </div>
      )}

      {data && (
        <>
          {/* 总览卡（任务 §5.1 全字段） */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
            <Stat label="账户权益" value={data.account.equity.toFixed(2)} />
            <Stat label="可用余额" value={data.account.balance.toFixed(2)} />
            <Stat label="占用保证金" value={data.account.marginUsed.toFixed(2)} />
            <Stat label="未实现盈亏" value={data.account.unrealizedPnl.toFixed(3)} cls={pnlClass(data.account.unrealizedPnl)} />
            <Stat label="已实现净收益（含滑点）" value={data.stats.realizedNetWithSlip.toFixed(3)} cls={pnlClass(data.stats.realizedNetWithSlip)} />
            <Stat label="累计手续费" value={data.stats.feePaid.toFixed(3)} />
            <Stat label="ROI" value={fmtPct(data.stats.roiPct)} cls={pnlClass(data.stats.roiPct)} />
            <Stat label="当前回撤" value={fmtPct(data.account.currentDrawdownPct)} cls={data.account.currentDrawdownPct > 5 ? 'text-down' : 'text-muted-foreground'} />
            <Stat label="持仓数" value={`${data.stats.openCount}/${data.config.maxPositions}`} />
            <Stat label="历史交易" value={String(data.stats.closedCount)} />
            <Stat label="胜率（含滑点口径）" value={fmtPct(data.stats.winRate)} />
            <Stat label="强平次数" value={String(data.stats.liquidatedCount)} cls={data.stats.liquidatedCount > 0 ? 'text-down' : 'text-muted-foreground'} />
          </div>

          {/* 当前持仓（任务 §5.2 全字段） */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <Wallet className="h-3.5 w-3.5 text-muted-foreground" /> 当前持仓（{data.positions.length}）
              <span className="text-[10px] font-normal text-muted-foreground">趋势信息与趋势面板同源（统一信号），持仓期间趋势变化实时可见</span>
            </div>
            {data.positions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-4 py-3 text-center text-xs text-muted-foreground">
                暂无自动持仓 · 确认趋势（CONFIRMED）出现后按 {(data.config.marginRatio * 100).toFixed(0)}% 权益 + {data.config.leverage}x 自动开仓；候选趋势/数据过期/暂停状态一律不开仓
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {data.positions.map((p) => (
                  <PositionCard key={p.positionId} p={p} onClose={(id) => act('close', id)} busy={busy} />
                ))}
              </div>
            )}
          </div>

          {/* 历史明细（任务 §5.3：筛选/排序/详情还原） */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <History className="h-3.5 w-3.5 text-muted-foreground" /> 历史交易（{history.data?.trades.length ?? 0}）
              <input
                value={filterSymbol}
                onChange={(e) => setFilterSymbol(e.target.value.toUpperCase())}
                placeholder="币种筛选"
                className="w-24 rounded border border-border bg-background px-2 py-0.5 text-[11px] outline-none focus:border-gold/60"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as 'time' | 'pnl')}
                className="rounded border border-border bg-background px-1 py-0.5 text-[11px] outline-none"
              >
                <option value="time">按平仓时间</option>
                <option value="pnl">按净盈亏</option>
              </select>
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')}
                className="rounded border border-border bg-background px-1 py-0.5 text-[11px] outline-none"
              >
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
            </div>
            {history.data && history.data.trades.length > 0 && (
              <div className="space-y-0.5">
                {history.data.trades.map((t) => (
                  <div key={t.positionId}>
                    <TradeRow t={t} onDetail={openDetail} />
                    {detailId === t.positionId && detail && (
                      <div className="mb-1 rounded border border-border/60 bg-secondary/20 px-3 py-2 text-[10px] leading-relaxed">
                        <div className="font-semibold">决策链还原（趋势周期 {detail.meta.trendCycleId}）</div>
                        <div className="mt-1 text-muted-foreground">
                          开仓时相位：{PHASE_V2_LABEL[detail.meta.trendPhaseAtOpen] ?? detail.meta.trendPhaseAtOpen}
                          {' '}· 开仓评分：{detail.meta.scoreAtOpen}
                          {detail.meta.signalAtOpen && detail.meta.signalAtOpen !== '{}' && (
                            <>
                              {' '}· 开仓依据：{(JSON.parse(detail.meta.signalAtOpen) as { reason?: string })?.reason ?? '—'}
                              {' '}· 波动状态：{(JSON.parse(detail.meta.signalAtOpen) as { features?: { volRegime?: string; atrPct?: number } })?.features?.volRegime ?? '—'}
                              {' '}· ATR%：{(JSON.parse(detail.meta.signalAtOpen) as { features?: { atrPct?: number } })?.features?.atrPct?.toFixed(2) ?? '—'}
                            </>
                          )}
                        </div>
                        {detail.meta.exitSignalJson && detail.meta.exitSignalJson !== '{}' && (
                          <div className="text-muted-foreground">
                            退出时信号：{(JSON.parse(detail.meta.exitSignalJson) as { reason?: string })?.reason ?? '—'}
                          </div>
                        )}
                        <div className="mt-1 space-y-0.5">
                          {detail.decisions.map((d) => (
                            <div key={d.id} className="text-muted-foreground">
                              <span className="font-mono">{fmtTime(d.createdAt)}</span> [{d.action}] {d.detail}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {detailId === t.positionId && !detail && (
                      <div className="mb-1 rounded border border-border/60 bg-secondary/20 px-3 py-2 text-[10px] text-muted-foreground">
                        加载详情中…
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {history.data && history.data.trades.length === 0 && (
              <div className="rounded-lg border border-dashed border-border/60 px-4 py-3 text-center text-xs text-muted-foreground">
                暂无已平仓交易
              </div>
            )}
          </div>

          {/* 决策与跳过审计（可折叠） */}
          <details className="rounded-lg border border-border/60 bg-card px-3 py-2">
            <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold">
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              决策/跳过审计（为什么开/为什么没开）
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-3 text-[10px] lg:grid-cols-2">
              <div>
                <div className="mb-1 font-semibold">最近跳过</div>
                {data.recentSkips.length === 0 && <div className="text-muted-foreground">无</div>}
                {data.recentSkips.slice(0, 15).map((s, i) => (
                  <div key={i} className="text-muted-foreground">
                    <span className="font-mono">{fmtAgo(s.t)}</span> {s.symbol} — {s.reason}
                  </div>
                ))}
              </div>
              <div>
                <div className="mb-1 font-semibold">最近决策（幂等键）</div>
                {data.recentDecisions.length === 0 && <div className="text-muted-foreground">无</div>}
                {data.recentDecisions.slice(0, 15).map((d) => (
                  <div key={d.id} className="truncate text-muted-foreground" title={d.detail}>
                    <span className="font-mono">{fmtAgo(d.createdAt)}</span> [{d.action}] {d.symbol} · {d.cycleId}
                  </div>
                ))}
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
