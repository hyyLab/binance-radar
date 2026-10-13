'use client';

import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCloseAllPositions, useClosePosition, useDeposit, useResetAccount } from '@/hooks/use-scanner';
import { fmtPrice, fmtQty, fmtTime } from '@/lib/format';
import type { PaperAccountResponse, PaperPositionDTO, PaperTradeDTO } from '@/lib/market/types';
import { cn, pnlCls } from '@/lib/utils';
import { Bot, ChevronDown, History, Layers, Plus, RotateCcw, Wallet } from 'lucide-react';

function AccountCard({
  label,
  value,
  sub,
  valueCls,
}: {
  label: string;
  value: string;
  sub?: string;
  valueCls?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-base font-bold tabular-nums sm:text-lg', valueCls)}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

const ACTION_LABEL: Record<PaperTradeDTO['action'], string> = {
  OPEN_LONG: '买入开多',
  OPEN_SHORT: '卖出开空',
  CLOSE_LONG: '平多',
  CLOSE_SHORT: '平空',
  LIQUIDATE: '强平',
};

export function PositionsTable({
  positions,
  onSelectSymbol,
  onClose,
  closing,
  emptyHint,
}: {
  positions: PaperPositionDTO[];
  onSelectSymbol: (s: string) => void;
  onClose: (id: string) => void;
  closing: boolean;
  emptyHint?: string;
}) {
  if (positions.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        {emptyHint ?? '暂无持仓 · 点击上方异动信号的「买入做多 / 卖出做空」或「手动开仓」一键建仓'}
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-3 text-muted-foreground">币对</TableHead>
          <TableHead className="text-muted-foreground">方向</TableHead>
          <TableHead className="text-right text-muted-foreground">杠杆</TableHead>
          <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
            保证金
          </TableHead>
          <TableHead className="hidden text-right text-muted-foreground md:table-cell">
            数量
          </TableHead>
          <TableHead className="text-right text-muted-foreground">开仓价</TableHead>
          <TableHead className="text-right text-muted-foreground">标记价</TableHead>
          <TableHead className="hidden text-right text-muted-foreground lg:table-cell">
            强平价
          </TableHead>
          <TableHead className="text-right text-muted-foreground">未实现盈亏</TableHead>
          <TableHead className="pr-3 text-right text-muted-foreground">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((p) => {
          const isLong = p.side === 'LONG';
          return (
            <TableRow key={p.id} className="border-border/50">
              <TableCell className="pl-3 font-semibold">
                <button onClick={() => onSelectSymbol(p.symbol)} className="hover:text-gold">
                  {p.base}
                  <span className="text-[10px] font-normal text-muted-foreground">/USDT</span>
                </button>
              </TableCell>
              <TableCell>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs font-bold',
                    isLong ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                  )}
                >
                  {isLong ? '做多' : '做空'}
                </span>
              </TableCell>
              <TableCell className="text-right text-xs font-semibold tabular-nums text-gold">
                {p.leverage}×
              </TableCell>
              <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">
                {p.margin.toFixed(2)}
              </TableCell>
              <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground md:table-cell">
                {fmtQty(p.qty)}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {fmtPrice(p.entryPrice)}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {fmtPrice(p.markPrice)}
              </TableCell>
              <TableCell className="hidden text-right text-xs tabular-nums text-down/80 lg:table-cell">
                {fmtPrice(p.liqPrice)}
              </TableCell>
              <TableCell className="text-right">
                <div className={cn('text-xs font-bold tabular-nums', pnlCls(p.unrealizedPnl))}>
                  {p.unrealizedPnl >= 0 ? '+' : ''}
                  {p.unrealizedPnl.toFixed(2)}
                </div>
                <div className={cn('text-[10px] tabular-nums', pnlCls(p.unrealizedPnl))}>
                  ROE {p.roePct >= 0 ? '+' : ''}
                  {p.roePct.toFixed(1)}%
                </div>
              </TableCell>
              <TableCell className="pr-3 text-right">
                <button
                  onClick={() => onClose(p.id)}
                  disabled={closing}
                  className="rounded bg-down px-2.5 py-1 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  一键平仓
                </button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function HistoryList({
  history,
  onSelectSymbol,
}: {
  history: PaperTradeDTO[];
  onSelectSymbol: (s: string) => void;
}) {
  const rows = history.filter((h) => h.action !== 'OPEN_LONG' && h.action !== 'OPEN_SHORT');
  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
        暂无平仓记录 · 完成第一笔交易后这里会显示盈亏流水
      </div>
    );
  }
  return (
    <div className="custom-scroll max-h-56 overflow-y-auto">
      {rows.map((h) => (
        <button
          key={h.id}
          onClick={() => onSelectSymbol(h.symbol)}
          title="点击查看该币 K 线"
          className="flex w-full items-center gap-2.5 border-b border-border/40 px-3 py-2 text-left text-xs transition-colors last:border-0 hover:bg-secondary/40"
        >
          <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
            {fmtTime(h.createdAt)}
          </span>
          <span
            className={cn(
              'w-14 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-bold',
              h.action === 'LIQUIDATE'
                ? 'bg-background text-down ring-1 ring-down/50'
                : h.pnl >= 0
                  ? 'bg-up/15 text-up'
                  : 'bg-down/15 text-down',
            )}
          >
            {ACTION_LABEL[h.action]}
          </span>
          <span className="w-20 shrink-0 truncate font-semibold">{h.symbol.replace(/USDT$/, '')}</span>
          <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
            {fmtPrice(h.price)}
          </span>
          <span className="flex-1 text-right tabular-nums text-muted-foreground">
            手续费 {h.fee.toFixed(3)}
          </span>
          <span className={cn('w-24 shrink-0 text-right font-bold tabular-nums', pnlCls(h.pnl))}>
            {h.pnl >= 0 ? '+' : ''}
            {h.pnl.toFixed(2)} U
          </span>
        </button>
      ))}
    </div>
  );
}

const DEPOSIT_PRESETS = [100, 500, 1000, 5000];

export function PaperPanel({
  data,
  loading,
  onSelectSymbol,
  onManualTrade,
}: {
  data: PaperAccountResponse | undefined;
  loading: boolean;
  onSelectSymbol: (s: string) => void;
  onManualTrade: () => void;
}) {
  const close = useClosePosition();
  const closeAll = useCloseAllPositions();
  const reset = useResetAccount();
  const deposit = useDeposit();
  const [resetOpen, setResetOpen] = useState(false);
  const [closeAllOpen, setCloseAllOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [histOpen, setHistOpen] = useState(false); // 平仓流水默认收起，点击标题展开

  const acc = data?.account;
  const positions = data?.positions ?? [];
  const history = data?.history ?? [];
  const totalUpnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const closedRows = history.filter((h) => h.action !== 'OPEN_LONG' && h.action !== 'OPEN_SHORT');
  const realizedSum = closedRows.reduce((s, h) => s + h.pnl, 0);

  const depositVal = Number(depositAmount);
  const depositValid = Number.isFinite(depositVal) && depositVal >= 10 && depositVal <= 1_000_000;
  const submitDeposit = () => {
    if (!depositValid || deposit.isPending) return;
    deposit.mutate(depositVal, {
      onSuccess: () => {
        setDepositOpen(false);
        setDepositAmount('');
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* 账户总览 */}
      <Card className="border-border/70 bg-card">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Wallet className="h-4 w-4 text-gold" />
              模拟建仓系统
            </CardTitle>
            <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold">
              本金 {acc ? (acc.initialCapital + acc.totalDeposited).toLocaleString('en-US') : '10'} USDT
              {acc && acc.totalDeposited > 0 ? '（含充值）' : ''} · 最高 20× · 币安 USDT-M 费率 Taker 0.05%/Maker 0.02%
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setDepositOpen(true)}
                className="flex items-center gap-1 rounded-md border border-gold/50 bg-gold/10 px-3 py-1.5 text-xs font-bold text-gold transition-colors hover:bg-gold/20"
                aria-label="充值模拟资金"
              >
                <Plus className="h-3.5 w-3.5" />
                充值
              </button>
              <button
                onClick={onManualTrade}
                className="flex items-center gap-1 rounded-md bg-gold px-3 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-90"
              >
                <Bot className="h-3.5 w-3.5" />
                手动开仓
              </button>
              <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
                <AlertDialogTrigger asChild>
                  <button
                    className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="重置模拟账户"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    重置
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认重置模拟账户？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将清空所有持仓与交易流水，资金恢复至 10 USDT（币安 USDT-M 合约规则）。此操作不可撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => reset.mutate()}
                      className="bg-down text-background hover:bg-down/90"
                    >
                      确认重置
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading || !acc ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <AccountCard
                label="总权益（含持仓盈亏）"
                value={`${acc.equity.toFixed(2)} U`}
                sub={`ROI ${acc.roiPct >= 0 ? '+' : ''}${acc.roiPct.toFixed(2)}%`}
                valueCls={pnlCls(acc.roiPct)}
              />
              <AccountCard
                label="可用余额"
                value={`${acc.balance.toFixed(2)} U`}
                sub={acc.totalDeposited > 0 ? `累计充值 +${acc.totalDeposited.toFixed(0)}` : undefined}
              />
              <AccountCard
                label="持仓保证金"
                value={`${acc.marginUsed.toFixed(2)} U`}
                sub={`${positions.length} 个仓位`}
              />
              <AccountCard
                label="未实现盈亏"
                value={`${acc.unrealizedPnl >= 0 ? '+' : ''}${acc.unrealizedPnl.toFixed(2)} U`}
                valueCls={pnlCls(acc.unrealizedPnl)}
              />
              <AccountCard
                label="累计已实现"
                value={`${acc.realizedPnl >= 0 ? '+' : ''}${acc.realizedPnl.toFixed(2)} U`}
                sub={`胜率 ${acc.closedCount + acc.liquidatedCount > 0 ? acc.winRate.toFixed(0) : '—'}% · 强平 ${acc.liquidatedCount} 次 · 费 ${acc.feePaid.toFixed(2)}`}
                valueCls={pnlCls(acc.realizedPnl)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* 充值弹窗 */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="w-[min(400px,95vw)]">
          <DialogTitle className="text-lg font-bold">充值模拟资金</DialogTitle>
          <DialogDescription className="text-xs">
            充值直接增加总权益，同步计入 ROI 本金基数（充值不算盈利）
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
            placeholder="自定义金额（10 ~ 1,000,000 USDT）"
            inputMode="decimal"
            aria-label="充值金额"
          />
          <button
            onClick={submitDeposit}
            disabled={!depositValid || deposit.isPending}
            className="w-full rounded-md bg-gold py-2.5 text-sm font-bold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deposit.isPending ? '到账中…' : depositValid ? `确认充值 +${depositVal.toFixed(2)} U` : '请输入充值金额'}
          </button>
          <p className="text-center text-[11px] text-muted-foreground">
            模拟盘充值 · 无真实资金流动 · 重置账户时充值记录会一并清零
          </p>
        </DialogContent>
      </Dialog>

      {/* 持仓 */}
      <Card className="border-border/70 bg-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              当前持仓
              {positions.length > 0 && (
                <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold tabular-nums">
                  {positions.length}
                </span>
              )}
            </CardTitle>
            {positions.length > 0 && (
              <AlertDialog open={closeAllOpen} onOpenChange={setCloseAllOpen}>
                <AlertDialogTrigger asChild>
                  <button
                    disabled={closeAll.isPending}
                    className="flex items-center gap-1 rounded-md bg-down px-3 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                    aria-label="一键平仓所有持仓"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    {closeAll.isPending ? '平仓中…' : '一键平仓全部'}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认平掉全部 {positions.length} 个持仓？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将按最新标记价市价平仓所有交易对，预估未实现盈亏{' '}
                      <span className={cn('font-bold tabular-nums', pnlCls(totalUpnl))}>
                        {totalUpnl >= 0 ? '+' : ''}
                        {totalUpnl.toFixed(2)} USDT
                      </span>
                      （未含平仓手续费）。此操作不可撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => closeAll.mutate()}
                      disabled={closeAll.isPending}
                      className="bg-down text-background hover:bg-down/90"
                    >
                      {closeAll.isPending ? '平仓中…' : '确认全部平仓'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="custom-scroll overflow-x-auto">
            {loading && !data ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <PositionsTable
                positions={positions}
                onSelectSymbol={onSelectSymbol}
                onClose={(id) => close.mutate(id)}
                closing={close.isPending}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* 流水：默认收起，点标题展开；合计盈亏常显在标题行 */}
      <Card className="border-border/70 bg-card">
        <button
          onClick={() => setHistOpen((o) => !o)}
          aria-expanded={histOpen}
          className="flex w-full items-center gap-2 px-6 py-4 pb-3 text-left transition-colors hover:text-gold"
        >
          <History className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-bold">平仓流水</span>
          <span className="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums text-muted-foreground">
            {closedRows.length}
          </span>
          {closedRows.length > 0 && (
            <span className={cn('text-xs font-semibold tabular-nums', pnlCls(realizedSum))}>
              合计 {realizedSum >= 0 ? '+' : ''}
              {realizedSum.toFixed(2)} U
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            {histOpen ? '收起' : '点开'}
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', histOpen && 'rotate-180')}
            />
          </span>
        </button>
        {histOpen && (
          <CardContent className="p-0">
            <HistoryList history={history} onSelectSymbol={onSelectSymbol} />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
