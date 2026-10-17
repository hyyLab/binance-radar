'use client';

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useFuturesTickers, useKlines, useTickers } from '@/hooks/use-market';
import { usePaperAccount, usePaperTrades } from '@/hooks/use-scanner';
import { fmtPct, fmtPrice, fmtVol, pctClass } from '@/lib/format';
import type { TickerSnapshot } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { KlineChart, type ChartPriceLine, type ChartTradeMarker } from './kline-chart';
import { PctBadge } from './shared';

const INTERVALS = [
  { v: '1m', label: '1分' },
  { v: '5m', label: '5分' },
  { v: '15m', label: '15分' },
  { v: '1h', label: '1时' },
  { v: '4h', label: '4时' },
  { v: '1d', label: '1天' },
] as const;

function StatItem({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm font-semibold tabular-nums', cls)}>{value}</div>
    </div>
  );
}

export function CoinDialog({
  symbol,
  onClose,
  market = 'spot',
  extraPriceLines,
  extraMarkers,
}: {
  symbol: string | null;
  onClose: () => void;
  /** K 线市场：异动交易页签传 futures（合约多源），默认币安现货 */
  market?: 'spot' | 'futures';
  /** 外部附加价格线（Task 55：趋势自动持仓的成本/强平线——与手动账户线叠加展示） */
  extraPriceLines?: ChartPriceLine[];
  /** 外部附加成交标记（Task 55：自动开仓时点标注在 K 线上） */
  extraMarkers?: ChartTradeMarker[];
}) {
  const [interval, setInterval] = useState<string>('15m');
  const { data: klines, isLoading } = useKlines(symbol, interval, !!symbol, market);
  const { data: tickersResp } = useTickers();
  const { data: futuresResp } = useFuturesTickers();
  const { data: paper } = usePaperAccount();
  const { data: tradesResp } = usePaperTrades(symbol);

  // 行情条：本市场优先，跨市场兑底
  const primaryTickers = market === 'futures' ? futuresResp?.data ?? [] : tickersResp?.data ?? [];
  const secondaryTickers = market === 'futures' ? tickersResp?.data ?? [] : futuresResp?.data ?? [];
  const ticker: TickerSnapshot | undefined = symbol
    ? (primaryTickers.find((t) => t.symbol === symbol) ??
       secondaryTickers.find((t) => t.symbol === symbol))
    : undefined;

  const base = symbol ? symbol.replace(/USDT$/, '') : '';
  const last = klines?.data[klines.data.length - 1];

  // 该币种的模拟持仓 → 图上绘制开仓成本线 + 强平价虚线
  const myPositions = useMemo(
    () => paper?.positions.filter((p) => p.symbol === symbol) ?? [],
    [paper?.positions, symbol],
  );
  const priceLines = useMemo<ChartPriceLine[]>(() => {
    const lines: ChartPriceLine[] = [];
    for (const p of myPositions) {
      const isLong = p.side === 'LONG';
      lines.push({
        price: p.entryPrice,
        color: isLong ? '#0ecb81' : '#f6465d',
        title: `${isLong ? '多' : '空'}单成本 ${p.leverage}x`,
      });
      lines.push({
        price: p.liqPrice,
        color: '#f6465d',
        title: '强平',
        dashed: true,
      });
    }
    // 外部附加线（趋势自动持仓等）：同价去重，外部线优先
    for (const l of extraPriceLines ?? []) {
      if (!lines.some((x) => Math.abs(x.price - l.price) < 1e-12 && x.title === l.title)) {
        lines.push(l);
      }
    }
    return lines;
  }, [myPositions, extraPriceLines]);

  // 历史交易 → 简洁 B/S 标记（B=买入 绿色▲，S=卖出 红色▼）+ 外部附加标记（自动开仓时点等）
  const tradeMarkers = useMemo<ChartTradeMarker[]>(() => {
    const list = tradesResp?.data ?? [];
    const out: ChartTradeMarker[] = [];
    for (const t of list) {
      const ts = new Date(t.createdAt).getTime();
      switch (t.action) {
        case 'OPEN_LONG':
        case 'CLOSE_SHORT': // 买入
          out.push({ timeMs: ts, position: 'belowBar', shape: 'arrowUp', color: '#0ecb81', text: 'B' });
          break;
        case 'OPEN_SHORT':
        case 'CLOSE_LONG':
        case 'LIQUIDATE': // 卖出
          out.push({ timeMs: ts, position: 'aboveBar', shape: 'arrowDown', color: '#f6465d', text: 'S' });
          break;
      }
    }
    return [...out, ...(extraMarkers ?? [])];
  }, [tradesResp, extraMarkers]);

  return (
    <Dialog open={!!symbol} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(880px,95vw)] overflow-y-auto custom-scroll">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DialogTitle className="text-xl font-bold">
            {base}
            <span className="text-sm font-normal text-muted-foreground">/USDT</span>
          </DialogTitle>
          {ticker && (
            <>
              <span className="text-xl font-bold tabular-nums">{fmtPrice(ticker.price)}</span>
              <PctBadge v={ticker.change24h} className="text-sm" />
            </>
          )}
        </div>
        <DialogDescription className="text-xs">
          {last
            ? `K 线时间轴为 UTC+8 · 最新收盘 ${fmtPrice(last.c)}`
            : market === 'futures'
              ? '合约 K 线（多源聚合，币安优先 · 服务端代理，缓存 20 秒）'
              : '币安现货 K 线（服务端代理，缓存 20 秒）'}
        </DialogDescription>

        <div className="flex flex-wrap gap-1" role="tablist" aria-label="K 线周期">
          {INTERVALS.map((it) => (
            <button
              key={it.v}
              role="tab"
              aria-selected={interval === it.v}
              onClick={() => setInterval(it.v)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                interval === it.v
                  ? 'bg-gold/15 text-gold'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>

        {isLoading && klines == null ? (
          <Skeleton className="h-[340px] w-full" />
        ) : klines && klines.data.length > 0 ? (
          <KlineChart data={klines.data} priceLines={priceLines} markers={tradeMarkers} />
        ) : (
          <div className="flex h-[340px] items-center justify-center rounded-lg border border-border/70 text-sm text-muted-foreground">
            {klines ? '暂无 K 线数据' : 'K 线加载失败，请稍后重试'}
          </div>
        )}

        {ticker && (
          <div className="space-y-2">
            {myPositions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-gold/30 bg-gold/5 px-3 py-1.5 text-xs">
                <span className="font-semibold text-gold">我的模拟持仓：</span>
                {myPositions.map((p) => (
                  <span key={p.id} className="tabular-nums">
                    <span className={cn('font-bold', p.side === 'LONG' ? 'text-up' : 'text-down')}>
                      {p.side === 'LONG' ? '多' : '空'} {p.leverage}x
                    </span>{' '}
                    成本 {fmtPrice(p.entryPrice)} · 浮盈 {p.unrealizedPnl >= 0 ? '+' : ''}
                    {p.unrealizedPnl.toFixed(2)} U
                  </span>
                ))}
              </div>
            )}
            {(tradesResp?.data.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">
                  该币种已记录 {tradesResp?.data.length} 笔交易
                </span>
                <span>
                  <span className="font-bold text-up">B</span> = 买入 ·{' '}
                  <span className="font-bold text-down">S</span> = 卖出（已标注在 K 线上）
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatItem
              label="24h 最高"
              value={fmtPrice(ticker.high24h)}
              cls={ticker.price >= ticker.high24h ? 'text-up' : undefined}
            />
            <StatItem
              label="24h 最低"
              value={fmtPrice(ticker.low24h)}
              cls={ticker.price <= ticker.low24h ? 'text-down' : undefined}
            />
            <StatItem label="24h 开盘" value={fmtPrice(ticker.open)} />
            <StatItem label="24h 成交额" value={`${fmtVol(ticker.quoteVolume24h)} USDT`} />
            <StatItem
              label="5 分钟涨跌"
              value={fmtPct(ticker.chg5m)}
              cls={pctClass(ticker.chg5m)}
            />
            <StatItem
              label="15 分钟涨跌"
              value={fmtPct(ticker.chg15m)}
              cls={pctClass(ticker.chg15m)}
            />
            <StatItem label="1 小时涨跌" value={fmtPct(ticker.chg1h)} cls={pctClass(ticker.chg1h)} />
            <StatItem
              label="量比（vs 20 分钟均值）"
              value={ticker.volMultiple != null ? `${ticker.volMultiple.toFixed(1)}×` : '—'}
              cls={
                ticker.volMultiple != null && ticker.volMultiple >= 6 ? 'text-gold' : undefined
              }
            />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
