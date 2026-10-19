'use client';

// ---------- 趋势自动模拟交易页（Task 54 §5 + Task 55 交互增强 + Task 56 修复） ----------
// 与手动模拟盘完全隔离（独立账户 trend-auto-v1）：总览 + 当前持仓 + 历史明细 + 控制。
// Task 55：① 机器人充值按钮（独立账户余额/ROI 本金同步增加，不计盈亏）
//          ② 持仓数量可选（最大同时持仓数；更换数量时自动平仓原有持仓）
//          ③ 点击持仓卡片 → 打开该币种 K 线（叠加成本线/强平线/开仓时点标记）
// Task 55-2：④ 持仓数量更换/全部平仓/重置改用页内 AlertDialog（不再用浏览器原生 confirm）
//            ⑤ 重置按钮：清空持仓与历史，资金回到 100 USDT（ROI 基准归零）
//            ⑥ 模型判定趋势确认结束后机器人自行平仓（后端 manageExits v3），无需人工兜底
//            ⑦ 历史交易展示开仓时间 + 平仓时间
// Task 56：⑧ sizing 改为「开仓时账户权益 × 20%」（与持仓数量解耦）；入场需二次确认
//          （确认后等一根新收盘 K 线复核）+ 质量门槛（评分/ER/高周期）+ 同币种冷却 5 分钟
// Task 80：⑨ 历史交易旁一键导出「AI 分析报告」（Markdown 附件，受众 LLM 做算法优化）
// ⚠️ 纯模拟交易；趋势评分为启发式证据分；趋势确认 ≠ 买卖指令；强平如实统计。

import { useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  CircleAlert,
  FileDown,
  History,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
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
import { CoinDialog } from '@/components/market/coin-dialog';
import type { ChartPriceLine, ChartTradeMarker } from '@/components/market/kline-chart';
import { ParamsConsole } from '@/components/trend-trade/params-console';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';

/** 与服务端 TREND_TRADE.MAX_POSITIONS_OPTIONS 保持一致 */
const POSITION_OPTIONS = [1, 2, 3, 4, 5, 6, 8];
/** 与手动盘充值预设一致 */
const DEPOSIT_PRESETS = [100, 500, 1000, 5000];
const MIN_DEPOSIT = 10;
const MAX_DEPOSIT = 1_000_000;

/** 历史交易用：月-日 时:分:秒（fmtTime 仅时分秒，跨天历史需要日期；title 展示完整日期） */
function fmtStamp(iso: string | number | null): string {
  if (iso == null) return '—';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
}

const EXIT_REASON_LABEL: Record<string, string> = {
  TREND_ENDED: '趋势结束',
  REVERSE_CONFIRMED: '反向确认',
  LIQUIDATED: '强平',
  MANUAL: '人工平仓',
  // Task 74：策略层个性离场原因的显示映射（短周期套利 / 通用趋势引擎 / 重大异动突破）
  STOP_LOSS: '硬止损',
  SPIKE_TAKE: '冲高落袋',
  TRAIL_TAKE: '移动止盈',
  WEAKNESS_EARLY: '走弱离场',
  // Task 83：退池超时自动离场（信号缺失持续超宽限期，释放舱位/保证金）
  DELIST_TIMEOUT: '退池超时',
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

function Stat({ label, value, cls, title }: { label: string; value: string; cls?: string; title?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2" title={title}>
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

// ============ 当前持仓卡片（Task 55：整卡可点 → 查看对应 K 线） ============

function PositionCard({
  p,
  onClose,
  onSelectSymbol,
  busy,
}: {
  p: TrendPositionRow;
  onClose: (positionId: string) => void;
  onSelectSymbol: (symbol: string) => void;
  busy: boolean;
}) {
  const long = p.side === 'LONG';
  return (
    <div
      className={cn(
        'cursor-pointer rounded-lg border bg-card p-2.5 transition-colors hover:border-gold/50',
        long ? 'border-up/30' : 'border-down/30',
      )}
      onClick={() => onSelectSymbol(p.symbol)}
      title="点击查看该币种 K 线（含持仓成本线 / 强平线 / 开仓时点标记）"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', long ? 'bg-up/20 text-up' : 'bg-down/20 text-down')}>
          {long ? '做多' : '做空'} {p.leverage}x
        </span>
        <span className="font-mono text-xs font-bold">{p.base}<span className="text-muted-foreground">/USDT</span></span>
        <span className="ml-auto font-mono text-xs tabular-nums">{fmtPrice(p.markPrice)}</span>
        <button
          className="inline-flex h-7 items-center rounded border border-border px-2 text-[11px] text-muted-foreground hover:text-gold disabled:opacity-40"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onSelectSymbol(p.symbol);
          }}
          title="查看 K 线"
        >
          K线
        </button>
        <button
          className="inline-flex h-7 items-center rounded border border-border px-2 text-[11px] text-muted-foreground hover:text-down disabled:opacity-40"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onClose(p.positionId);
          }}
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
          <CircleAlert className="h-3 w-3" /> 模型已判定趋势有问题（出现结束迹象），机器人将自行平仓（下一轮巡检执行，无需人工操作）
        </div>
      )}
    </div>
  );
}

// ============ 历史明细行 ============

function TradeRow({
  t,
  onDetail,
  onKline,
}: {
  t: TrendTradeRow;
  onDetail: (id: string) => void;
  onKline: (t: TrendTradeRow) => void;
}) {
  const exitLabel = EXIT_REASON_LABEL[t.exitReason ?? ''] ?? (t.exitReason ?? '—');
  const net = t.netPnlWithSlip;
  return (
    <button
      onClick={() => onDetail(t.positionId)}
      className="w-full rounded px-2 py-2 text-left text-[11px] tabular-nums hover:bg-secondary/40 sm:grid sm:grid-cols-[92px_92px_60px_44px_1fr_1fr_64px_88px] sm:items-center sm:gap-1 sm:px-2 sm:py-1"
      title="点击查看开仓依据与趋势变化详情；点击币种可看 K 线"
    >
      {/* Task 74：移动端两行紧凑卡片（桌面端保持 8 列表格行） */}
      <span className="flex items-center gap-1.5 sm:hidden">
        <span className={cn('shrink-0 font-bold', t.side === 'LONG' ? 'text-up' : 'text-down')}>
          {t.side === 'LONG' ? '多' : '空'}
          {t.reversed && (
            <span
              className="ml-0.5 rounded bg-gold/15 px-0.5 text-[9px] font-semibold text-gold"
              title={`反向跟随：模型信号${t.signalSide === 'LONG' ? '多' : '空'} → 实际执行${t.side === 'LONG' ? '多' : '空'}`}
            >
              反
            </span>
          )}
        </span>
        <span
          className="cursor-pointer font-mono font-semibold hover:text-gold"
          onClick={(e) => {
            e.stopPropagation();
            onKline(t);
          }}
          title={`点击查看 ${t.symbol} K 线（含开/平仓价线与时点标记）`}
        >
          {t.base}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {fmtPrice(t.entryPrice)} → {t.exitPrice != null ? fmtPrice(t.exitPrice) : '—'}
        </span>
        <span className={cn('ml-auto shrink-0 font-bold', pnlClass(net))}>
          {net != null ? net.toFixed(3) : '—'}
        </span>
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground sm:hidden">
        <span className="shrink-0">{fmtStamp(t.openedAt)}</span>
        <span
          className="min-w-0 truncate"
          title={`算法：${t.strategyName ?? t.strategyId ?? '—'}（费用/滑点累计口径见顶部统计卡）`}
        >
          {t.strategyName ?? t.strategyId ?? '—'}
        </span>
        <span className={cn('ml-auto shrink-0 font-semibold', exitLabel === '强平' ? 'text-down' : '')}>
          {exitLabel}
        </span>
      </span>
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={`开仓 ${new Date(t.openedAt).toLocaleString('zh-CN')} → 持仓 ${t.holdMinutes ?? '—'} 分钟`}
      >
        {fmtStamp(t.openedAt)}
      </span>
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={t.closedAt ? `平仓 ${new Date(t.closedAt).toLocaleString('zh-CN')} · 持仓 ${t.holdMinutes ?? '—'} 分钟` : ''}
      >
        {fmtStamp(t.closedAt)}
      </span>
      <span
        className="hidden cursor-pointer truncate font-mono font-semibold hover:text-gold sm:block"
        onClick={(e) => {
          e.stopPropagation();
          onKline(t);
        }}
        title={`点击查看 ${t.symbol} K 线（含开/平仓价线与时点标记）`}
      >
        {t.base}
      </span>
      <span className={cn('hidden font-bold sm:block', t.side === 'LONG' ? 'text-up' : 'text-down')}>
        {t.side === 'LONG' ? '多' : '空'}
        {t.reversed && (
          <span
            className="ml-0.5 rounded bg-gold/15 px-0.5 text-[9px] font-semibold text-gold"
            title={`反向跟随：模型信号${t.signalSide === 'LONG' ? '多' : '空'} → 实际执行${t.side === 'LONG' ? '多' : '空'}`}
          >
            反
          </span>
        )}
      </span>
      <span className="hidden truncate text-muted-foreground sm:block">
        {fmtPrice(t.entryPrice)} → {t.exitPrice != null ? fmtPrice(t.exitPrice) : '—'}
      </span>
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={`算法：${t.strategyName ?? t.strategyId ?? '—'}（费用/滑点不再逐行展示，累计口径见顶部统计卡）`}
      >
        {t.strategyName ?? t.strategyId ?? '—'}
      </span>
      <span className={cn('hidden truncate font-semibold sm:block', exitLabel === '强平' ? 'text-down' : 'text-muted-foreground')}>
        {exitLabel}
      </span>
      <span className={cn('hidden text-right font-bold sm:block', pnlClass(net))}>
        {net != null ? net.toFixed(3) : '—'}
      </span>
    </button>
  );
}

/** 历史明细表头（与 TradeRow 同网格：开仓时间/平仓时间两列明确标注） */
function TradeHeader() {
  return (
    <div className="hidden gap-1 px-2 text-[10px] text-muted-foreground/70 sm:grid sm:grid-cols-[92px_92px_60px_44px_1fr_1fr_64px_88px]">
      <span>开仓时间</span>
      <span>平仓时间</span>
      <span>币种</span>
      <span>方向</span>
      <span>开仓 → 平仓</span>
      <span>算法</span>
      <span>原因</span>
      <span className="text-right">净盈亏(含滑)</span>
    </div>
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
  // Task 63：历史明细默认只展示最近 10 条，其余折叠（一键展开/收起，避免列表过长刷屏）
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const history = useTrendTradeHistory(filterSymbol, sort, order);
  // Task 80：一键导出 AI 分析报告（/api/trend-trading/report → Markdown 附件下载）
  const [reportBusy, setReportBusy] = useState(false);
  const handleExportReport = async () => {
    if (reportBusy) return;
    setReportBusy(true);
    try {
      const res = await fetch('/api/trend-trading/report');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const m = (res.headers.get('Content-Disposition') ?? '').match(/filename="?([^";]+)"?/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m?.[1] ?? 'trend-report.md';
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'AI 报告已导出', description: 'Markdown 文件已下载，可直接投喂给 AI 分析优化算法' });
    } catch (e) {
      toast({ title: '导出失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally {
      setReportBusy(false);
    }
  };
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TradeDetail | null>(null);
  // Task 55：充值弹窗 + K 线弹窗（点击持仓卡片 / 历史交易币种）
  // Task 55-3：K 线上下文扩展——持仓（成本/强平线 + 开仓标记）与历史交易（开/平仓价线 + 开/平标记）
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [kline, setKline] = useState<{ symbol: string; row?: TrendTradeRow } | null>(null);
  // Task 57-c：参数控制台弹窗
  const [paramsOpen, setParamsOpen] = useState(false);
  // Task 55-2：操作确认内部弹窗（持仓数量更换 / 全部平仓 / 重置 / 切换算法）——替代浏览器原生 confirm
  const [confirm, setConfirm] = useState<
    null | { type: 'changePositions'; value: number } | { type: 'closeAll' } | { type: 'reset' } | { type: 'changeStrategy'; value: string }
  >(null);

  const mode = data?.mode ?? 'RUNNING';
  const busy = control.isPending;
  const maxPositions = data?.config.maxPositions ?? 4;
  const totalDeposited = data?.account.totalDeposited ?? 0;
  // Task 57：当前算法与可选策略列表（overview API 提供）
  const strategyId = data?.config.strategyId ?? 'short-swing-v1';
  const strategies = data?.config.strategies ?? [];
  const currentStrategy = strategies.find((s) => s.id === strategyId);
  // Task 71：单仓比例显示真值化——min(设定比例, 95%÷舱位数)；重大异动突破另乘形态风险倍率 0.5~1.0
  const effRatioPct = ((data?.config.effMarginRatio ?? 0.2) * 100).toFixed(3).replace(/\.?0+$/, '');
  const isMajorP1 = strategyId === 'major-p1-breakout-v1';
  // Task 75：反向跟随开关状态（overview params 的 infra 布尔参数）
  const reverseModeOn = (data?.config.params ?? []).some((p) => p.key === 'reverseMode' && p.value === true);

  const depositVal = Number(depositAmount);
  const depositValid = Number.isFinite(depositVal) && depositVal >= MIN_DEPOSIT && depositVal <= MAX_DEPOSIT;

  const act = (
    action: string,
    positionId?: string,
    value?: number | string,
    amount?: number,
    /** 配置变更类操作（换仓位数/切换算法/充值/重置）成功后用 toast 展示服务端说明；常规操作由界面状态反馈 */
    alertNote?: boolean,
    /** Task 57-c：setRuntimeParams 的全量参数值 */
    params?: Record<string, number | boolean>,
  ) =>
    control.mutate(
      { action, positionId, value, amount, params },
      {
        onSuccess: (r) => {
          if (!r.ok && r.error)
            toast({ title: '操作失败', description: r.error, variant: 'destructive' });
          else if (alertNote && r.note) toast({ title: '操作成功', description: r.note });
        },
        onError: (e) => toast({ title: '操作失败', description: e.message, variant: 'destructive' }),
      },
    );

  const submitDeposit = () => {
    if (!depositValid) return;
    act('deposit', undefined, undefined, depositVal, true);
    setDepositOpen(false);
    setDepositAmount('');
  };

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

  // Task 55/55-3：K 线弹窗附加物——自动持仓（成本线/强平线/开仓时点）或历史交易（开/平仓价线与标记）
  const klinePosition = useMemo(
    () => (kline && !kline.row ? data?.positions.find((p) => p.symbol === kline.symbol) ?? null : null),
    [data, kline],
  );
  const klinePriceLines = useMemo<ChartPriceLine[] | undefined>(() => {
    if (!kline) return undefined;
    // 历史交易：开仓价 + 平仓价（已平仓）两条参考线
    if (kline.row) {
      const r = kline.row;
      const lines: ChartPriceLine[] = [
        {
          price: r.entryPrice,
          color: r.side === 'LONG' ? '#0ecb81' : '#f6465d',
          title: `开仓 ${r.leverage}x`,
        },
      ];
      if (r.exitPrice != null) lines.push({ price: r.exitPrice, color: '#a78bfa', title: '平仓' });
      return lines;
    }
    // 当前持仓：成本线 + 强平虚线
    const p = klinePosition;
    if (!p) return undefined;
    const long = p.side === 'LONG';
    return [
      {
        price: p.entryPrice,
        color: long ? '#0ecb81' : '#f6465d',
        title: `自动${long ? '多' : '空'}成本 ${p.leverage}x`,
      },
      { price: p.liqPrice, color: '#f6465d', title: '强平', dashed: true },
    ];
  }, [kline, klinePosition]);
  const klineMarkers = useMemo<ChartTradeMarker[] | undefined>(() => {
    if (!kline) return undefined;
    // 历史交易：开仓 + 平仓两个时点标记
    if (kline.row) {
      const r = kline.row;
      const long = r.side === 'LONG';
      const markers: ChartTradeMarker[] = [
        {
          timeMs: new Date(r.openedAt).getTime(),
          position: long ? 'belowBar' : 'aboveBar',
          shape: long ? 'arrowUp' : 'arrowDown',
          color: long ? '#0ecb81' : '#f6465d',
          text: '开',
        },
      ];
      if (r.closedAt) {
        markers.push({
          timeMs: new Date(r.closedAt).getTime(),
          position: long ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: '#a78bfa',
          text: '平',
        });
      }
      return markers;
    }
    // 当前持仓：开仓时点标记
    const p = klinePosition;
    if (!p) return undefined;
    const long = p.side === 'LONG';
    return [
      {
        timeMs: new Date(p.openedAt).getTime(),
        position: long ? 'belowBar' : 'aboveBar',
        shape: long ? 'arrowUp' : 'arrowDown',
        color: long ? '#0ecb81' : '#f6465d',
        text: '开',
      },
    ];
  }, [kline, klinePosition]);

  // Task 55-2：改用页内 AlertDialog 确认（不再用浏览器原生 confirm）
  const changePositions = (v: number) => {
    if (v === maxPositions) return;
    setConfirm({ type: 'changePositions', value: v });
  };

  // Task 57：切换算法（确认后自动平仓清场 + 热切换）
  const changeStrategy = (v: string) => {
    if (v === strategyId) return;
    setConfirm({ type: 'changeStrategy', value: v });
  };

  // Task 74：头部账户/算法摘要——桌面单行内联，移动端独立成行（原来手机端完全不可见）
  const headerInfo = (
    <>
      账户 {data?.config.accountName ?? 'trend-auto-v1'} · 初始 {data?.config.initialCapital ?? '—'} USDT
      {totalDeposited > 0 && <span className="text-gold"> · 累计充值 +{totalDeposited.toFixed(0)}</span>} · 算法
      {currentStrategy?.name ?? strategyId} · 每仓 =
      开仓时权益 × {effRatioPct}%{isMajorP1 && '（按入场形态再乘 0.5~1.0 风险倍率）'} · {data?.config.leverage ?? 20}x · 无固定止盈止损（按算法规则离场）
    </>
  );

  return (
    <div className="space-y-3">
      {/* 头部：标题 + 模式 + 控制（Task 74：移动端控制区 3 行网格 + 36px 触控目标） */}
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-4 w-4 text-gold" />
        <h1 className="text-sm font-bold sm:text-base">趋势自动模拟交易</h1>
        <ModeBadge mode={mode} />
        {reverseModeOn && (
          <span
            className="rounded bg-down/15 px-2 py-0.5 text-[11px] font-bold text-down"
            title="反向跟随已开启：所有算法开仓方向取反执行（模型开多→实际开空、开空→实际开多），保证金/轮次/审计不变；平仓时机仍跟随模型——模型硬止损=我们止盈、模型止盈=我们止损（盈亏互为镜像）。可在参数控制台关闭。"
          >
            反向跟随
          </span>
        )}
        <span className="hidden text-[10px] text-muted-foreground sm:inline">{headerInfo}</span>
        <div className="w-full text-[10px] leading-relaxed text-muted-foreground sm:hidden">{headerInfo}</div>
        <div className="grid w-full grid-cols-4 gap-1.5 sm:ml-auto sm:flex sm:w-auto sm:items-center sm:gap-1.5">
          {/* Task 57-c：参数控制台——自行调整自动开仓参数（保存即热生效） */}
          <button
            className="inline-flex h-9 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-muted-foreground hover:border-gold/50 hover:text-gold disabled:opacity-40 sm:h-8 sm:text-[11px]"
            disabled={busy}
            onClick={() => setParamsOpen(true)}
            title="自动开仓参数控制台：入场门槛/入场时机/轮次/冲高套利/冷却等，保存后立即生效（附每项含义说明）"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> 参数
            {(data?.config.params ?? []).some((p) => p.overridden) && (
              <span className="rounded bg-gold/20 px-1 text-[9px] font-bold text-gold">改</span>
            )}
          </button>
          {/* Task 57：算法可选——更换即自动平仓原有持仓，新算法接管后续开仓（Task 74：整块触控 + 原生选择器，16px 防 iOS 聚焦缩放） */}
          <label
            className="relative col-span-3 flex h-9 cursor-pointer items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs sm:col-span-1 sm:h-8 sm:text-[11px]"
            title={currentStrategy?.description ?? '交易算法（可插拔策略；更换会自动平仓原有持仓）'}
          >
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">算法 </span>
              <span className="font-semibold text-foreground">{currentStrategy?.name ?? strategyId}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <select
              value={strategyId}
              disabled={busy}
              onChange={(e) => changeStrategy(e.target.value)}
              aria-label="交易算法"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-background text-foreground text-base opacity-0 outline-none"
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {/* Task 55：持仓数量可选——更换即自动平仓原有持仓（Task 74：整块触控） */}
          <label
            className="relative col-span-2 flex h-9 cursor-pointer items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs sm:col-span-1 sm:h-8 sm:text-[11px]"
            title="最大同时持仓数；更换数量会自动平仓原有持仓。每仓保证金 = 开仓时权益 × min(设定比例, 95%÷配置舱位数)——选 1 舱单仓满配 95%，选 N 舱各 95%/N，先开仓不挤占后舱；余额不足时跳过并记录。比例可在参数控制台调整"
          >
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">持仓 </span>
              <span className="font-semibold text-foreground">{maxPositions} 仓</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <select
              value={maxPositions}
              disabled={busy}
              onChange={(e) => changePositions(Number(e.target.value))}
              aria-label="最大同时持仓数"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-background text-foreground text-base opacity-0 outline-none"
            >
              {POSITION_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} 仓
                </option>
              ))}
            </select>
          </label>
          {/* Task 55：机器人充值 */}
          <button
            className="inline-flex h-9 items-center justify-center gap-1 rounded-md border border-gold/50 bg-gold/10 px-2 text-xs font-bold text-gold hover:bg-gold/20 disabled:opacity-40 sm:h-8 sm:text-[11px]"
            disabled={busy}
            onClick={() => setDepositOpen(true)}
            title="给机器人账户充值（增加可用余额，计入 ROI 本金基数，不算盈利）"
          >
            <Plus className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> 充值
          </button>
          {mode === 'RUNNING' ? (
            <button
              className="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-gold/50 px-2 text-xs font-semibold text-gold hover:bg-gold/10 disabled:opacity-40 sm:col-span-1 sm:h-8 sm:text-[11px]"
              disabled={busy}
              onClick={() => act('pause')}
              title="暂停新开仓；现有持仓继续监控"
            >
              <Pause className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> 暂停开仓
            </button>
          ) : (
            <button
              className="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-up/50 px-2 text-xs font-semibold text-up hover:bg-up/10 disabled:opacity-40 sm:col-span-1 sm:h-8 sm:text-[11px]"
              disabled={busy}
              onClick={() => act('resume')}
            >
              <Play className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> 恢复交易
            </button>
          )}
          <button
            className="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-down/50 px-2 text-xs font-semibold text-down hover:bg-down/10 disabled:opacity-40 sm:col-span-1 sm:h-8 sm:text-[11px]"
            disabled={busy || (data?.positions.length ?? 0) === 0}
            onClick={() => setConfirm({ type: 'closeAll' })}
            title="全部平仓（不影响运行模式）"
          >
            <Square className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> 全部平仓
          </button>
          {/* Task 55-2：重置机器人账户——清空持仓与历史，资金回到 100 USDT */}
          <button
            className="inline-flex h-9 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-muted-foreground hover:border-gold/50 hover:text-gold disabled:opacity-40 sm:h-8 sm:text-[11px]"
            disabled={busy}
            onClick={() => setConfirm({ type: 'reset' })}
            title="重置机器人账户：清空全部持仓与历史交易，资金重置为 100 USDT（不可撤销）"
          >
            <RotateCcw className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> 重置
          </button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground/80">
        ⚠️ 纯模拟交易，不接入真实下单。趋势评分为启发式证据分（未经回放校准，非胜率/概率）；趋势确认 ≠ 买卖指令；强平为杠杆模拟执行结果，如实计入统计。
        {data && !data.service.on && <span className="ml-2 text-gold">服务尚未运行（访问本页自动拉起）</span>}
        {/* Task 82：算法失配可见化——本次实测故障（切换后仍跑旧算法）就是被这种隐形错配误导 */}
        {data && data.service.runningStrategyId !== data.config.strategyId && (
          <span className="ml-2 text-down">
            ⚠️ 算法失配：配置 {data.config.strategyId}，实际运行 {data.service.runningStrategyId}；新开仓已暂停，请重启服务
          </span>
        )}
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
            <Stat
              label="反向世界对照（镜像净利）"
              value={data.stats.reverseWorldPnl.toFixed(3)}
              cls={pnlClass(data.stats.reverseWorldPnl)}
              title="Task 83：同一批交易若反向跟随执行的理论净利 = -净利；模型在强确认/过度延伸处入场、投降处离场的错位，就是反向世界的盈利来源"
            />
            <Stat label="累计手续费" value={data.stats.feePaid.toFixed(3)} />
            <Stat label="ROI" value={fmtPct(data.stats.roiPct)} cls={pnlClass(data.stats.roiPct)} />
            <Stat label="当前回撤" value={fmtPct(data.account.currentDrawdownPct)} cls={data.account.currentDrawdownPct > 5 ? 'text-down' : 'text-muted-foreground'} />
            <Stat label="持仓数" value={`${data.stats.openCount}/${data.config.maxPositions}`} />
            <Stat label="历史交易" value={String(data.stats.closedCount)} />
            <Stat label="胜率（含滑点口径）" value={fmtPct(data.stats.winRate)} />
            <Stat label="强平次数" value={String(data.stats.liquidatedCount)} cls={data.stats.liquidatedCount > 0 ? 'text-down' : 'text-muted-foreground'} />
          </div>

          {/* 当前持仓（任务 §5.2 全字段；Task 55：点击卡片看 K 线） */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <Wallet className="h-3.5 w-3.5 text-muted-foreground" /> 当前持仓（{data.positions.length}）
              <span className="text-[10px] font-normal text-muted-foreground">
                点击持仓卡片查看对应 K 线（成本线/强平线/开仓时点）· 趋势信息与趋势面板同源
              </span>
            </div>
            {data.positions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-4 py-3 text-center text-xs text-muted-foreground">
                暂无自动持仓 · 等待策略触发后按当前算法规则开仓（每仓 = 开仓时权益 × {effRatioPct}%{isMajorP1 && '，另乘形态风险倍率 0.5~1.0'} +{' '}
                {data.config.leverage}x）；同币种平仓后冷却（默认 5 分钟）；门槛/时机详见「参数」控制台
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {data.positions.map((p) => (
                  <PositionCard
                    key={p.positionId}
                    p={p}
                    onClose={(id) => act('close', id)}
                    onSelectSymbol={(s) => setKline({ symbol: s })}
                    busy={busy}
                  />
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
                className="h-8 w-24 rounded border border-border bg-background px-2 text-base outline-none focus:border-gold/60 sm:text-xs"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as 'time' | 'pnl')}
                className="h-8 rounded border border-border bg-background px-2 text-base outline-none sm:text-xs"
              >
                <option value="time">按平仓时间</option>
                <option value="pnl">按净盈亏</option>
              </select>
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')}
                className="h-8 rounded border border-border bg-background px-2 text-base outline-none sm:text-xs"
              >
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
              <button
                onClick={handleExportReport}
                disabled={reportBusy}
                title="导出全量历史分析报告（Markdown，供 AI 优化算法）"
                className="ml-auto flex items-center gap-1 rounded border border-gold/50 bg-gold/10 px-2 py-1 text-[11px] font-semibold text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
              >
                <FileDown className="h-3 w-3" /> {reportBusy ? '生成中…' : '导出AI报告'}
              </button>
            </div>
            {history.data && history.data.trades.length > 0 && (
              <div className="space-y-0.5">
                <TradeHeader />
                {(historyExpanded ? history.data.trades : history.data.trades.slice(0, 10)).map((t) => (
                  <div key={t.positionId}>
                    <TradeRow t={t} onDetail={openDetail} onKline={(row) => setKline({ symbol: row.symbol, row })} />
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
                {history.data.trades.length > 10 && (
                  <button
                    onClick={() => setHistoryExpanded((v) => !v)}
                    className="w-full rounded border border-border/60 bg-secondary/30 px-2 py-2 text-center text-[11px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground sm:py-1"
                  >
                    {historyExpanded
                      ? '收起，仅显示最近 10 条'
                      : `展开更早的 ${history.data.trades.length - 10} 条（共 ${history.data.trades.length} 条）`}
                  </button>
                )}
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

      {/* Task 55：机器人充值弹窗（与手动盘同规则：10 ~ 1,000,000 USDT） */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="w-[min(400px,calc(100vw-1rem))]">
          <DialogTitle className="text-lg font-bold">给机器人充值</DialogTitle>
          <DialogDescription className="text-xs">
            充值直接增加「{data?.config.accountName ?? 'trend-auto-v1'}」可用余额，同步计入 ROI 本金基数（充值不算盈利）；
            与手动模拟盘账户完全隔离
          </DialogDescription>
          <div className="grid grid-cols-4 gap-1.5">
            {DEPOSIT_PRESETS.map((v) => (
              <button
                key={v}
                onClick={() => setDepositAmount(String(v))}
                className={cn(
                  'rounded border py-1.5 text-xs font-semibold transition-colors',
                  depositAmount === String(v)
                    ? 'border-gold/60 bg-gold/15 text-gold'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                +{v.toLocaleString('en-US')}
              </button>
            ))}
          </div>
          <Input
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder={`自定义金额（${MIN_DEPOSIT} ~ ${MAX_DEPOSIT.toLocaleString('en-US')} USDT）`}
            inputMode="decimal"
            aria-label="机器人充值金额"
          />
          <button
            onClick={submitDeposit}
            disabled={!depositValid || busy}
            className="w-full rounded-md bg-gold py-2.5 text-sm font-bold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '到账中…' : depositValid ? `确认充值 +${depositVal.toFixed(2)} U` : '请输入充值金额'}
          </button>
          <p className="text-center text-[11px] text-muted-foreground">
            纯模拟充值 · 无真实资金流动 · 当前可用 {data?.account.balance.toFixed(2) ?? '—'} U
          </p>
        </DialogContent>
      </Dialog>

      {/* Task 57-c：参数控制台（保存 = setRuntimeParams 全量值；恢复默认 = resetRuntimeParams） */}
      <ParamsConsole
        open={paramsOpen}
        onOpenChange={setParamsOpen}
        params={data?.config.params ?? []}
        busy={busy}
        onSave={(values) => act('setRuntimeParams', undefined, undefined, undefined, true, values)}
        onReset={() => act('resetRuntimeParams', undefined, undefined, undefined, true)}
        strategyName={currentStrategy?.name}
      />

      {/* Task 55：持仓/历史交易 K 线弹窗（合约多源 K 线；持仓=成本线/强平线/开仓标记，历史=开平仓价线/时点标记） */}
      <CoinDialog
        symbol={kline?.symbol ?? null}
        onClose={() => setKline(null)}
        market="futures"
        extraPriceLines={klinePriceLines}
        extraMarkers={klineMarkers}
      />

      {/* Task 55-2：操作确认内部弹窗（持仓数量更换 / 全部平仓 / 重置）——替代浏览器原生 confirm */}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="w-[min(420px,calc(100vw-1rem))] p-4 sm:p-6">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-bold">
              {confirm?.type === 'changePositions' && `确认将持仓数量改为 ${confirm.value} 仓？`}
              {confirm?.type === 'closeAll' && '确认全部平仓？'}
              {confirm?.type === 'reset' && '确认重置机器人账户？'}
              {confirm?.type === 'changeStrategy' &&
                `确认切换算法为「${strategies.find((s) => s.id === confirm.value)?.name ?? confirm.value}」？`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1 text-xs leading-relaxed">
                {confirm?.type === 'changePositions' && (
                  <>
                    <span className="block">· 将自动平仓当前全部 {data?.positions.length ?? 0} 笔持仓（按标记价市价）</span>
                    <span className="block">· 持仓数量决定仓位划分：每仓保证金 = 开仓时权益 × min(设定比例， 95%÷配置舱位数)——选 1 舱满配 95%、N 舱各 95%/N，先开仓不挤占后舱（余额不足仍跳过并记录）</span>
                    <span className="block">· 新确认趋势按新口径开仓；被平掉的旧趋势周期不会立即重开</span>
                  </>
                )}
                {confirm?.type === 'closeAll' && (
                  <>
                    <span className="block">· 按标记价市价平掉全部 {data?.positions.length ?? 0} 笔自动持仓</span>
                    <span className="block">· 不影响运行模式（运行/暂停状态保持不变）</span>
                  </>
                )}
                {confirm?.type === 'reset' && (
                  <>
                    <span className="block">· 先按标记价平掉全部持仓，再清空全部历史交易与决策审计记录</span>
                    <span className="block">· 资金重置为 100 USDT，ROI 本金基准归零；运行模式与持仓数量保持不变</span>
                    <span className="block font-semibold text-down">· 此操作不可撤销，请谨慎确认</span>
                  </>
                )}
                {confirm?.type === 'changeStrategy' && (
                  <>
                    <span className="block">
                      · 新算法说明：{strategies.find((s) => s.id === confirm.value)?.description ?? '-'}
                    </span>
                    <span className="block">· 将自动平仓当前全部 {data?.positions.length ?? 0} 笔持仓（不同算法持仓管理规则不同，不混管）</span>
                    <span className="block">· 切换后由新算法按其规则决策开仓；算法选择持久化，重启后保持</span>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className={cn(
                confirm?.type === 'reset' && 'bg-down text-white hover:bg-down/90',
                confirm?.type === 'closeAll' && 'bg-down/90 text-white hover:bg-down',
              )}
              onClick={() => {
                if (!confirm) return;
                if (confirm.type === 'changePositions') act('setMaxPositions', undefined, confirm.value, undefined, true);
                else if (confirm.type === 'closeAll') act('closeAll');
                else if (confirm.type === 'changeStrategy') act('setStrategy', undefined, confirm.value, undefined, true);
                else act('reset', undefined, undefined, undefined, true);
              }}
            >
              {confirm?.type === 'changePositions' && '确认更换'}
              {confirm?.type === 'closeAll' && '全部平仓'}
              {confirm?.type === 'reset' && '确认重置'}
              {confirm?.type === 'changeStrategy' && '确认切换'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
