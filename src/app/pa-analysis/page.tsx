'use client';

// ---------- /pa-analysis · PA 自动择机引擎页面（任务书 §九） ----------
// 五区域：①全池扫描概览 ②候选币种列表 ③详细分析面板 ④自动交易 ⑤历史与配置。
// 数据源：/api/pa-analysis/*；轮询 10s；所有交易动作走服务端 API。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import PaKlineChart, { type KlinePoint } from '@/components/pa/kline-chart';

// ============ 类型 ============

interface PaConfig {
  enabled: number; aiEnabled: number; riskPerTradePct: number; maxPositions: number;
  maxTotalRiskPct: number; leverage: number; tp1CloseRatio: number; breakevenAfterTp1: number;
  orderExpiryMs: number; entryMaxDeviationPct: number; stopCooldownMs: number;
  analysisCooldownMs: number; aiConcurrency: number; minRiskReward: number; slippageBps: number;
}
interface Summary {
  ok: boolean; ts: number; config: PaConfig;
  stats: Record<string, number>;
  candidateStatus: Record<string, number>;
  coordination: Record<string, number>;
  pools: { poolId: string; poolName: string; count: number; describe: string; error: string | null }[];
  universe: { totalRaw: number; unique: number; ts: number };
  scheduler: { startedAt: number; lastScanAt: number; lastExecuteAt: number; lastError: string | null; queue: { queued: number; running: number; processed: number; failed: number; lastError: string | null } };
  lastScan: Record<string, number> | null;
  equity: number; balance: number;
}
interface Candidate {
  symbol: string; status: string; sourcePools: { poolId: string; poolName: string; status: string }[];
  uteDirection: string | null; utePhase: string | null; uteScore: number | null;
  coordinationState: string | null; coordinationDecision: string | null;
  lastAnalysisAt: number | null; lastReason: string | null; pendingOrderId: string | null;
}
interface PendingOrder {
  id: string; symbol: string; direction: string; kind: string; triggerPrice: number;
  stopLoss: number; takeProfit1: number; takeProfit2: number; qty: number; margin: number;
  leverage: number; status: string; cancelReason: string | null; createdAt: number;
}
interface PaPosition {
  positionId: string; symbol: string; side: string; leverage: number; margin: number; qty: number;
  entryPrice: number; markPrice: number; unrealizedPnl: number;
  meta: { stopLoss: number; takeProfit1: number; takeProfit2: number; tp1Done: number; status: string; realizedPnl: number } | null;
}
interface PaClosedTrade {
  positionId: string; symbol: string; side: string; entryPrice: number; exitPrice: number | null;
  pnl: number | null; status: string; closedAt: string | null; exitReason: string | null;
}
interface HistoryRec {
  id: string; symbol: string; direction: string; barTime5m: number; status: string;
  coordinationState: string; coordinationDecision: string; error: string | null;
  aiLatencyMs: number; createdAt: string;
  plan: string | null; planJson?: string;
}
interface AnalysisDetail {
  ok: boolean;
  record: {
    id: string; symbol: string; direction: string; status: string; error: string | null; aiLatencyMs: number;
    uteSnapshot: { trendCycleId?: string; score?: number; phase?: string };
    diagnosis: Record<string, unknown>;
    htf: Record<string, unknown>;
    coordination: { state?: string; decision?: string; evidences?: string[]; reason?: string };
    plan: Record<string, unknown> | null;
    validator: { id: string; label: string; passed: boolean; detail: string }[] | null;
  };
}

const STATUS_LABELS: Record<string, string> = {
  DISCOVERED: '发现', ELIGIBLE: '合格', PA_ANALYZING: '分析中', WAITING_CONFIRMATION: '等待确认',
  PLAN_READY: '计划就绪', REJECTED: '已拒绝', EXPIRED: '已过期',
};
const COORD_LABELS: Record<string, string> = {
  ALIGNED: '方向一致', PULLBACK_DIVERGENCE: '回调分歧', STRUCTURAL_CONFLICT: '结构冲突', UNCERTAIN: '信息不足',
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  return (await r.json()) as T;
}
function fmtTime(t: number | string | null | undefined): string {
  if (!t) return '-';
  const d = typeof t === 'number' ? new Date(t) : new Date(t);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtNum(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

export default function PaAnalysisPage() {
  const { toast } = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [orders, setOrders] = useState<{ active: PendingOrder[]; recent: PendingOrder[] }>({ active: [], recent: [] });
  const [trades, setTrades] = useState<{ positions: PaPosition[]; closed: PaClosedTrade[] }>({ positions: [], closed: [] });
  const [history, setHistory] = useState<HistoryRec[]>([]);
  const [config, setConfig] = useState<PaConfig | null>(null);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterPool, setFilterPool] = useState('ALL');
  const [q, setQ] = useState('');
  const [detailSymbol, setDetailSymbol] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [k5m, setK5m] = useState<KlinePoint[]>([]);
  const [k15m, setK15m] = useState<KlinePoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, c, o, t, h] = await Promise.all([
        api<Summary>('/api/pa-analysis/summary'),
        api<{ ok: boolean; candidates: Candidate[] }>('/api/pa-analysis/candidates?limit=300'),
        api<{ ok: boolean; active: PendingOrder[]; recent: PendingOrder[] }>('/api/pa-analysis/orders'),
        api<{ ok: boolean; positions: PaPosition[]; closed: PaClosedTrade[] }>('/api/pa-analysis/trades'),
        api<{ ok: boolean; records: HistoryRec[] }>('/api/pa-analysis/history?limit=40'),
      ]);
      if (s.ok) { setSummary(s); setConfig(s.config); }
      if (c.ok) setCandidates(c.candidates);
      if (o.ok) setOrders({ active: o.active, recent: o.recent });
      if (t.ok) setTrades({ positions: t.positions, closed: t.closed });
      if (h.ok) setHistory(h.records.map((r) => ({ ...r, plan: r.planJson ?? r.plan })));
    } catch {
      /* 轮询失败静默（下轮重试） */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const filtered = useMemo(() => {
    return candidates.filter((c) => {
      if (filterStatus !== 'ALL' && c.status !== filterStatus) return false;
      if (filterPool !== 'ALL' && !c.sourcePools.some((p) => p.poolId === filterPool)) return false;
      if (q && !c.symbol.includes(q.toUpperCase())) return false;
      return true;
    });
  }, [candidates, filterStatus, filterPool, q]);

  const openDetail = useCallback(async (symbol: string) => {
    setDetailSymbol(symbol);
    setDetail(null);
    setK5m([]);
    setK15m([]);
    try {
      const h = await api<{ ok: boolean; records: HistoryRec[] }>(`/api/pa-analysis/history?symbol=${symbol}&limit=1`);
      if (h.ok && h.records.length > 0) {
        const d = await api<AnalysisDetail>(`/api/pa-analysis/history/${encodeURIComponent(h.records[0].id)}`);
        if (d.ok) setDetail(d);
      }
      const [k5, k15] = await Promise.all([
        api<{ ok: boolean; data: KlinePoint[] }>(`/api/market/klines?symbol=${symbol}&interval=5m&market=futures&limit=120`),
        api<{ ok: boolean; data: KlinePoint[] }>(`/api/market/klines?symbol=${symbol}&interval=15m&market=futures&limit=60`),
      ]);
      if (k5.ok) setK5m(k5.data);
      if (k15.ok) setK15m(k15.data);
    } catch {
      toast({ title: '详情加载失败', description: '请稍后重试' });
    }
  }, [toast]);

  const planLines = useMemo(() => {
    const plan = detail?.record.plan as { entry_price?: number; stop_loss_price?: number; take_profit_price?: number; take_profit_price_2?: number; entryPrice?: number; stopLoss?: number; takeProfit1?: number; takeProfit2?: number } | null;
    if (!plan) return null;
    return {
      entry: plan.entryPrice ?? plan.entry_price ?? null,
      stopLoss: plan.stopLoss ?? plan.stop_loss_price ?? null,
      takeProfit1: plan.takeProfit1 ?? plan.take_profit_price ?? null,
      takeProfit2: plan.takeProfit2 ?? plan.take_profit_price_2 ?? null,
    };
  }, [detail]);

  async function control(action: 'start' | 'pause') {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string; error?: string }>('/api/pa-analysis/strategy', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      toast({ title: r.ok ? '操作成功' : '操作失败', description: r.message ?? r.error ?? '' });
      await refresh();
    } finally { setBusy(false); }
  }

  async function triggerScan() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string; error?: string }>('/api/pa-analysis/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      toast({ title: r.ok ? '已触发全池扫描' : '触发失败', description: r.message ?? r.error ?? '' });
      await refresh();
    } finally { setBusy(false); }
  }

  async function saveConfig() {
    if (!config) return;
    setSavingCfg(true);
    try {
      const r = await api<{ ok: boolean; error?: string; message?: string }>('/api/pa-analysis/config', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
      });
      toast({ title: r.ok ? '配置已保存' : '保存失败', description: r.message ?? r.error ?? '' });
      await refresh();
    } finally { setSavingCfg(false); }
  }

  async function cancelOrder(id: string) {
    const r = await api<{ ok: boolean; message: string }>(`/api/pa-analysis/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    toast({ title: r.ok ? '已撤销' : '撤销失败', description: r.message });
    await refresh();
  }

  async function closePosition(id: string) {
    const r = await api<{ ok: boolean; message: string }>(`/api/pa-analysis/trades/${encodeURIComponent(id)}/close`, { method: 'POST' });
    toast({ title: r.ok ? '已提交平仓' : '平仓失败', description: r.message });
    await refresh();
  }

  const enabled = config?.enabled === 1;
  const st = summary?.stats ?? {};

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
        {/* 头部 */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">PA 自动择机引擎 · pa-action-v1</h1>
            <p className="text-xs text-muted-foreground">
              全池扫描 → UTE 趋势 → PA 两阶段诊断 → 四态协同 → 结构止损/分批止盈 · 独立模拟账户 pa-auto-v1 · 纯模拟，无真实下单
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={enabled ? 'default' : 'secondary'}>{enabled ? '运行中' : '已暂停'}</Badge>
            <Badge variant={config?.aiEnabled === 1 ? 'default' : 'outline'}>AI {config?.aiEnabled === 1 ? '开启' : '关闭'}</Badge>
            <Button size="sm" variant={enabled ? 'destructive' : 'default'} disabled={busy} onClick={() => control(enabled ? 'pause' : 'start')}>
              {enabled ? '暂停新开仓' : '启用策略'}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={triggerScan}>手动全池扫描</Button>
            <Button size="sm" variant="ghost" asChild>
              <a href="/">← 返回雷达</a>
            </Button>
          </div>
        </header>

        {/* ① 全池扫描概览 */}
        <section>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">① 全池扫描概览（实际扫描范围与池子来源）</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-center md:grid-cols-6">
                {[
                  ['接入池数', `${summary?.pools.length ?? 0}`],
                  ['池内币次', `${summary?.universe.totalRaw ?? 0}`],
                  ['去重候选', `${summary?.universe.unique ?? 0}`],
                  ['UTE 有效方向', `${summary?.lastScan?.uteValid ?? 0}`],
                  ['待入场单', `${summary?.stats.activePendings ?? 0}`],
                  ['PA 持仓', `${summary?.stats.openPositions ?? 0}`],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border bg-card/50 p-2">
                    <div className="text-lg font-semibold">{v}</div>
                    <div className="text-[11px] text-muted-foreground">{k}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 text-center md:grid-cols-4">
                {Object.entries({
                  ALIGNED: 'ALIGNED 一致', PULLBACK_DIVERGENCE: '回调分歧', STRUCTURAL_CONFLICT: '结构冲突', UNCERTAIN: '信息不足',
                }).map(([k, label]) => (
                  <div key={k} className="rounded-lg border bg-card/50 p-2">
                    <div className="text-lg font-semibold">{summary?.coordination?.[k] ?? 0}</div>
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {(summary?.pools ?? []).map((p) => (
                  <div key={p.poolId} className="rounded-lg border p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{p.poolName}</span>
                      <Badge variant={p.error ? 'destructive' : 'secondary'}>{p.error ? '读取失败' : `${p.count} 币`}</Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{p.describe}</div>
                    {p.error && <div className="mt-1 text-[11px] text-red-400">{p.error}</div>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ② 候选币种列表 */}
        <section>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
              <CardTitle className="text-sm">② 候选币种列表（点击行查看详细分析）</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Input className="h-8 w-36" placeholder="搜索 SYMBOL" value={q} onChange={(e) => setQ(e.target.value)} />
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部状态</SelectItem>
                    {Object.entries(STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filterPool} onValueChange={setFilterPool}>
                  <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部来源池</SelectItem>
                    {(summary?.pools ?? []).map((p) => <SelectItem key={p.poolId} value={p.poolId}>{p.poolName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-h-96 overflow-y-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr>
                      {['Symbol', '来源池', 'UTE', 'PA 方向', '15m 背景', '协同', '决策', '状态', '最近分析', '原因'].map((h) => (
                        <th key={h} className="px-2 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={10} className="px-2 py-6 text-center text-muted-foreground">暂无候选（等待扫描/AI 分析）</td></tr>
                    )}
                    {filtered.map((c) => {
                      const paDir = c.coordinationState ? (c.coordinationDecision === 'ALLOW' ? '与 UTE 同向' : c.coordinationDecision === 'REJECT' ? '反向证据' : '短期反向/不足') : '-';
                      return (
                        <tr key={c.symbol} className="cursor-pointer border-t transition-colors hover:bg-muted/40" onClick={() => void openDetail(c.symbol)}>
                          <td className="px-2 py-1.5 font-medium">{c.symbol}</td>
                          <td className="px-2 py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {c.sourcePools.map((p, i) => <Badge key={i} variant="outline" className="px-1 py-0 text-[10px]">{p.poolName}</Badge>)}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">{c.uteDirection === 'up' ? '↑多' : c.uteDirection === 'down' ? '↓空' : '-'} <span className="text-muted-foreground">{c.utePhase?.replace('CONFIRMED_', '') ?? ''}</span></td>
                          <td className="px-2 py-1.5">{paDir}</td>
                          <td className="px-2 py-1.5">-</td>
                          <td className="px-2 py-1.5">{c.coordinationState ? COORD_LABELS[c.coordinationState] ?? c.coordinationState : '-'}</td>
                          <td className="px-2 py-1.5">
                            <Badge variant={c.coordinationDecision === 'ALLOW' ? 'default' : c.coordinationDecision === 'REJECT' ? 'destructive' : 'secondary'}>
                              {c.coordinationDecision ?? '-'}
                            </Badge>
                          </td>
                          <td className="px-2 py-1.5">{STATUS_LABELS[c.status] ?? c.status}</td>
                          <td className="px-2 py-1.5">{fmtTime(c.lastAnalysisAt)}</td>
                          <td className="max-w-56 truncate px-2 py-1.5 text-muted-foreground" title={c.lastReason ?? ''}>{c.lastReason ?? '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ④ 自动交易 */}
        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">④ 自动交易 · 运行状态与统计（pa-auto-v1 模拟账户）</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center md:grid-cols-4">
                {[
                  ['权益', fmtNum(summary?.equity, 2)],
                  ['余额', fmtNum(summary?.balance, 2)],
                  ['累计收益', fmtNum(summary?.stats.realizedPnl, 2)],
                  ['今日/累计交易', `${trades.closed.length}`],
                  ['胜率%', fmtNum(summary?.stats.winRate, 1)],
                  ['Profit Factor', summary?.stats.profitFactor === Infinity ? '∞' : fmtNum(summary?.stats.profitFactor)],
                  ['最大回撤%', fmtNum(summary?.stats.maxDrawdownPct)],
                  ['手续费', fmtNum(summary?.stats.feePaid)],
                  ['平均持仓(min)', fmtNum(summary?.stats.avgHoldMinutes, 0)],
                  ['AI 队列', `${summary?.scheduler.queue.queued ?? 0}/${summary?.scheduler.queue.running ?? 0}`],
                  ['AI 成功/失败', `${summary?.scheduler.queue.processed ?? 0}/${summary?.scheduler.queue.failed ?? 0}`],
                  ['暂停管理', '止损/TP 照常'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border bg-card/50 p-2">
                    <div className="text-sm font-semibold">{v}</div>
                    <div className="text-[10px] text-muted-foreground">{k}</div>
                  </div>
                ))}
              </div>
              <div className="text-[11px] text-muted-foreground">
                最近扫描：{fmtTime(summary?.scheduler.lastScanAt)} · 最近执行循环：{fmtTime(summary?.scheduler.lastExecuteAt)}
                {summary?.scheduler.lastError && <span className="text-red-400"> · 最近错误：{summary.scheduler.lastError}</span>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">待入场单（可撤销）</CardTitle></CardHeader>
            <CardContent>
              <div className="max-h-60 overflow-y-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/80"><tr>{['Symbol', '类型', '方向', '触发价', 'SL', 'TP1', 'TP2', '数量', '保证金', '操作'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {orders.active.length === 0 && <tr><td colSpan={10} className="px-2 py-4 text-center text-muted-foreground">暂无 ACTIVE 待入场单</td></tr>}
                    {orders.active.map((o) => (
                      <tr key={o.id} className="border-t">
                        <td className="px-2 py-1.5 font-medium">{o.symbol}</td>
                        <td className="px-2 py-1.5">{o.kind}</td>
                        <td className="px-2 py-1.5">{o.direction === 'LONG' ? '多' : '空'}</td>
                        <td className="px-2 py-1.5">{fmtNum(o.triggerPrice, 6)}</td>
                        <td className="px-2 py-1.5 text-red-400">{fmtNum(o.stopLoss, 6)}</td>
                        <td className="px-2 py-1.5 text-green-400">{fmtNum(o.takeProfit1, 6)}</td>
                        <td className="px-2 py-1.5 text-emerald-400">{fmtNum(o.takeProfit2, 6)}</td>
                        <td className="px-2 py-1.5">{fmtNum(o.qty, 4)}</td>
                        <td className="px-2 py-1.5">{fmtNum(o.margin)}</td>
                        <td className="px-2 py-1.5"><Button size="sm" variant="outline" className="h-6 px-2" onClick={() => void cancelOrder(o.id)}>撤销</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* 持仓 + 已平仓 */}
        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">当前 PA 持仓（可手动平仓）</CardTitle></CardHeader>
            <CardContent>
              <div className="max-h-60 overflow-y-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/80"><tr>{['Symbol', '方向', '开仓价', '标记价', 'SL', 'TP1/TP2', 'TP1', '浮动盈亏', '操作'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {trades.positions.length === 0 && <tr><td colSpan={9} className="px-2 py-4 text-center text-muted-foreground">暂无 PA 持仓</td></tr>}
                    {trades.positions.map((p) => (
                      <tr key={p.positionId} className="border-t">
                        <td className="px-2 py-1.5 font-medium">{p.symbol}</td>
                        <td className="px-2 py-1.5">{p.side === 'LONG' ? '多' : '空'} {p.leverage}x</td>
                        <td className="px-2 py-1.5">{fmtNum(p.entryPrice, 6)}</td>
                        <td className="px-2 py-1.5">{fmtNum(p.markPrice, 6)}</td>
                        <td className="px-2 py-1.5 text-red-400">{fmtNum(p.meta?.stopLoss, 6)}</td>
                        <td className="px-2 py-1.5">{fmtNum(p.meta?.takeProfit1, 6)} / {fmtNum(p.meta?.takeProfit2, 6)}</td>
                        <td className="px-2 py-1.5">{p.meta?.tp1Done ? '✓' : '-'}</td>
                        <td className={`px-2 py-1.5 ${p.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtNum(p.unrealizedPnl)}</td>
                        <td className="px-2 py-1.5"><Button size="sm" variant="outline" className="h-6 px-2" onClick={() => void closePosition(p.positionId)}>平仓</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">已平仓交易（含退出原因）</CardTitle></CardHeader>
            <CardContent>
              <div className="max-h-60 overflow-y-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/80"><tr>{['Symbol', '方向', '开→平', '盈亏', '退出原因', '平仓时间'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {trades.closed.length === 0 && <tr><td colSpan={6} className="px-2 py-4 text-center text-muted-foreground">暂无已平仓交易</td></tr>}
                    {trades.closed.map((t) => (
                      <tr key={t.positionId} className="border-t">
                        <td className="px-2 py-1.5 font-medium">{t.symbol}</td>
                        <td className="px-2 py-1.5">{t.side === 'LONG' ? '多' : '空'}</td>
                        <td className="px-2 py-1.5">{fmtNum(t.entryPrice, 5)} → {fmtNum(t.exitPrice, 5)}</td>
                        <td className={`px-2 py-1.5 ${(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtNum(t.pnl)}</td>
                        <td className="px-2 py-1.5">{t.exitReason ?? t.status}</td>
                        <td className="px-2 py-1.5">{fmtTime(t.closedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ⑤ 历史 + 配置 */}
        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">⑤ 历史 PA 分析（点击查看详情；含协同证据/校验清单）</CardTitle></CardHeader>
            <CardContent>
              <div className="max-h-72 overflow-y-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/80"><tr>{['时间', 'Symbol', '方向', '协同', '决策', '状态', '耗时', '说明'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {history.length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">暂无分析记录</td></tr>}
                    {history.map((h) => (
                      <tr key={h.id} className="cursor-pointer border-t hover:bg-muted/40" onClick={() => void openDetail(h.symbol)}>
                        <td className="px-2 py-1.5">{fmtTime(h.createdAt)}</td>
                        <td className="px-2 py-1.5 font-medium">{h.symbol}</td>
                        <td className="px-2 py-1.5">{h.direction === 'LONG' ? '多' : '空'}</td>
                        <td className="px-2 py-1.5">{COORD_LABELS[h.coordinationState] ?? h.coordinationState}</td>
                        <td className="px-2 py-1.5">{h.coordinationDecision}</td>
                        <td className="px-2 py-1.5">{h.status}</td>
                        <td className="px-2 py-1.5">{(h.aiLatencyMs / 1000).toFixed(1)}s</td>
                        <td className="max-w-40 truncate px-2 py-1.5 text-muted-foreground" title={h.error ?? ''}>{h.error ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">策略配置（后端校验；保存即热生效）</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {config && (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {([
                      ['riskPerTradePct', '每笔风险 %', 0.1, 5, 0.1],
                      ['maxPositions', '最大持仓数', 1, 10, 1],
                      ['maxTotalRiskPct', '总风险敞口 %', 0.5, 20, 0.5],
                      ['leverage', '杠杆', 1, 20, 1],
                      ['tp1CloseRatio', 'TP1 平仓比例', 0.1, 1, 0.1],
                      ['minRiskReward', '最小盈亏比', 0.5, 5, 0.1],
                      ['entryMaxDeviationPct', '入场偏差 %', 0.05, 5, 0.05],
                      ['orderExpiryMs', '订单有效期 ms', 60_000, 21_600_000, 60_000],
                      ['stopCooldownMs', '止损冷却 ms', 0, 86_400_000, 60_000],
                      ['analysisCooldownMs', '分析冷却 ms', 60_000, 21_600_000, 60_000],
                      ['aiConcurrency', 'AI 并发', 1, 4, 1],
                      ['slippageBps', '滑点 bps', 0, 50, 1],
                    ] as [keyof PaConfig, string, number, number, number][]).map(([key, label, min, max, step]) => (
                      <div key={key} className="space-y-1">
                        <Label className="text-[11px]">{label}</Label>
                        <Input
                          className="h-8" type="number" min={min} max={max} step={step} value={String(config[key])}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setConfig((c) => (c ? { ...c, [key]: v } : c));
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={config.aiEnabled === 1} onChange={(e) => setConfig({ ...config, aiEnabled: e.target.checked ? 1 : 0 })} />
                      AI 分析开关
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={config.breakevenAfterTp1 === 1} onChange={(e) => setConfig({ ...config, breakevenAfterTp1: e.target.checked ? 1 : 0 })} />
                      TP1 后止损移保本（默认关）
                    </label>
                    <Button size="sm" disabled={savingCfg} onClick={() => void saveConfig()}>保存配置</Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>

        <footer className="pb-6 text-center text-[11px] text-muted-foreground">
          纯模拟交易研究 · AI 失败/数据不足/校验不通过一律拒绝开仓，绝不降级为 UTE-only · estimated_win_rate 为模型估计值，非真实历史胜率
        </footer>
      </div>

      {/* ③ 详细分析面板（Dialog） */}
      <Dialog open={detailSymbol != null} onOpenChange={(o) => !o && setDetailSymbol(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>详细分析 · {detailSymbol}</DialogTitle>
          </DialogHeader>
          {!detail ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {detailSymbol ? '加载中…（该币种尚无分析记录时仅显示行情图）' : ''}
            </div>
          ) : (
            <div className="space-y-4">
              {/* K 线图 + 计划价格线 */}
              <div className="grid gap-3 md:grid-cols-2">
                <PaKlineChart title="5m 主分析（K1=最新已收盘）" points={k5m} plan={planLines} />
                <PaKlineChart title="15m 高周期背景" points={k15m} />
              </div>

              {/* UTE 原始判断 */}
              <div className="rounded-lg border p-3 text-xs">
                <div className="mb-1 font-semibold">UTE 原始判断（不改写）</div>
                <div className="text-muted-foreground">
                  phase={detail.record.uteSnapshot.phase ?? '-'} · score={fmtNum(detail.record.uteSnapshot.score, 0)} · cycle={detail.record.uteSnapshot.trendCycleId ?? '-'} · 分析方向={detail.record.direction}
                </div>
              </div>

              {/* 协同 */}
              <div className="rounded-lg border p-3 text-xs">
                <div className="mb-1 font-semibold">
                  协同判定：{detail.record.coordination.state ? COORD_LABELS[detail.record.coordination.state] ?? detail.record.coordination.state : '-'}
                  <Badge className="ml-2" variant={detail.record.coordination.decision === 'ALLOW' ? 'default' : detail.record.coordination.decision === 'REJECT' ? 'destructive' : 'secondary'}>
                    {detail.record.coordination.decision ?? '-'}
                  </Badge>
                </div>
                <div className="mb-1 text-muted-foreground">{detail.record.coordination.reason ?? ''}</div>
                <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {(detail.record.coordination.evidences ?? []).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>

              {/* PA Stage1 诊断 */}
              <div className="rounded-lg border p-3 text-xs">
                <div className="mb-1 font-semibold">PA Stage1 诊断（5m，全字段留档）</div>
                <div className="grid gap-1 text-muted-foreground md:grid-cols-2">
                  <div>周期形态：{String((detail.record.diagnosis as Record<string, unknown>).cycle_position ?? '-')}</div>
                  <div>方向偏好：{String((detail.record.diagnosis as Record<string, unknown>).direction ?? '-')}</div>
                  <div>置信度：{String((detail.record.diagnosis as Record<string, unknown>).diagnosis_confidence ?? '-')}</div>
                  <div>市场阶段：{String((detail.record.diagnosis as Record<string, unknown>).market_phase ?? '-')}</div>
                  <div className="md:col-span-2">HTF 上下文：{String((detail.record.diagnosis as Record<string, unknown>).htf_context ?? '-')}</div>
                  <div className="md:col-span-2">15m 背景：{JSON.stringify(detail.record.htf)}</div>
                </div>
              </div>

              {/* Stage2 计划 + Validator */}
              {detail.record.plan && (
                <div className="rounded-lg border p-3 text-xs">
                  <div className="mb-1 font-semibold">Stage2 交易计划（程序校验后）</div>
                  <div className="grid grid-cols-2 gap-1 text-muted-foreground md:grid-cols-4">
                    <div>类型：{String((detail.record.plan as Record<string, unknown>).orderType ?? '-')}</div>
                    <div>方向：{String((detail.record.plan as Record<string, unknown>).direction ?? '-')}</div>
                    <div>Entry：{String((detail.record.plan as Record<string, unknown>).entryPrice ?? '-')}</div>
                    <div>SL：{String((detail.record.plan as Record<string, unknown>).stopLoss ?? '-')}</div>
                    <div>TP1：{String((detail.record.plan as Record<string, unknown>).takeProfit1 ?? '-')}</div>
                    <div>TP2：{String((detail.record.plan as Record<string, unknown>).takeProfit2 ?? '-')}</div>
                    <div>盈亏比：{String((detail.record.plan as Record<string, unknown>).rewardRisk ?? '-')}</div>
                    <div>估计胜率：{String((detail.record.plan as Record<string, unknown>).estimatedWinRate ?? '-')}%（模型估计）</div>
                  </div>
                  <div className="mt-2 text-muted-foreground">理由：{String((detail.record.plan as Record<string, unknown>).reasoning ?? '-')}</div>
                </div>
              )}
              {detail.record.validator && (
                <div className="rounded-lg border p-3 text-xs">
                  <div className="mb-1 font-semibold">Validator 检查清单</div>
                  <ul className="space-y-0.5">
                    {detail.record.validator.map((c) => (
                      <li key={c.id} className={c.passed ? 'text-muted-foreground' : 'text-red-400'}>
                        {c.passed ? '✓' : '✗'} {c.label}：{c.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.record.status !== 'OK' && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
                  分析状态：{detail.record.status} · {detail.record.error ?? ''}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
