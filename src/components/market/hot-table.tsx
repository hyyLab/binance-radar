'use client';

import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtMult, fmtPct, fmtPrice, fmtVol } from '@/lib/format';
import type { TickerSnapshot } from '@/lib/market/types';
import { cn } from '@/lib/utils';
import { FlashPrice, Pct, PctBadge } from './shared';
import { Search } from 'lucide-react';

type SortKey = 'vol' | 'chg24h' | 'chg5m' | 'chg1h';

const SORT_LABELS: Record<SortKey, string> = {
  vol: '24h 成交额',
  chg24h: '24h 涨跌幅',
  chg5m: '5 分钟涨跌',
  chg1h: '1 小时涨跌',
};

export function HotTable({
  tickers,
  loading,
  onSelect,
}: {
  tickers: TickerSnapshot[];
  loading: boolean;
  onSelect: (symbol: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('vol');

  const rows = useMemo(() => {
    const kw = search.trim().toUpperCase();
    const filtered = kw ? tickers.filter((t) => t.symbol.includes(kw)) : tickers;
    const sorted = [...filtered];
    switch (sortBy) {
      case 'vol':
        sorted.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
        break;
      case 'chg24h':
        sorted.sort((a, b) => b.change24h - a.change24h);
        break;
      case 'chg5m':
        sorted.sort((a, b) => (b.chg5m ?? -999) - (a.chg5m ?? -999));
        break;
      case 'chg1h':
        sorted.sort((a, b) => (b.chg1h ?? -999) - (a.chg1h ?? -999));
        break;
    }
    return sorted.slice(0, 50);
  }, [tickers, search, sortBy]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索币种，如 BTC、SOL…"
            className="pl-8"
            aria-label="搜索币种"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground">排序</span>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger className="h-9 w-[140px]" aria-label="排序方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SORT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="text-xs text-muted-foreground sm:ml-auto">
          {loading ? '加载中…' : `共 ${tickers.length} 个交易对，当前显示前 ${rows.length} 个`}
        </div>
      </div>

      <div className="custom-scroll max-h-[60vh] overflow-y-auto rounded-lg border border-border/70">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 pl-3 text-muted-foreground">#</TableHead>
              <TableHead className="text-muted-foreground">币对</TableHead>
              <TableHead className="text-right text-muted-foreground">最新价</TableHead>
              <TableHead className="text-right text-muted-foreground">24h 涨跌</TableHead>
              <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                5 分钟
              </TableHead>
              <TableHead className="hidden text-right text-muted-foreground md:table-cell">
                15 分钟
              </TableHead>
              <TableHead className="hidden text-right text-muted-foreground md:table-cell">
                1 小时
              </TableHead>
              <TableHead className="hidden text-right text-muted-foreground lg:table-cell">
                1 分钟额
              </TableHead>
              <TableHead className="hidden text-right text-muted-foreground lg:table-cell">
                量比
              </TableHead>
              <TableHead className="pr-3 text-right text-muted-foreground">24h 成交额</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={10} className="h-32 text-center text-muted-foreground">
                  {search ? `未找到包含 “${search}” 的交易对` : '行情加载中，请稍候…'}
                </TableCell>
              </TableRow>
            )}
            {rows.map((t, i) => (
              <TableRow
                key={t.symbol}
                onClick={() => onSelect(t.symbol)}
                className="cursor-pointer border-border/50"
                aria-label={`查看 ${t.symbol} 详情`}
              >
                <TableCell className="pl-3 text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </TableCell>
                <TableCell>
                  <div className="font-semibold">
                    {t.base}
                    <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
                      /USDT
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <FlashPrice value={t.price} dir={t.tickDir} />
                </TableCell>
                <TableCell className="text-right">
                  <PctBadge v={t.change24h} className="min-w-14" />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <Pct v={t.chg5m} className="text-xs" />
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <Pct v={t.chg15m} className="text-xs" />
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <Pct v={t.chg1h} className="text-xs" />
                </TableCell>
                <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground lg:table-cell">
                  {fmtVol(t.vol1m)}
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {t.volMultiple != null && t.volMultiple >= 3 ? (
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                        t.volMultiple >= 6
                          ? 'bg-gold/15 text-gold'
                          : 'bg-secondary text-secondary-foreground',
                      )}
                    >
                      {fmtMult(t.volMultiple)}
                    </span>
                  ) : (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {fmtMult(t.volMultiple)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="pr-3 text-right text-xs tabular-nums text-muted-foreground">
                  {fmtVol(t.quoteVolume24h)}
                  <span className="ml-0.5 text-[10px] text-muted-foreground/70">USDT</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        · 仅展示 24h 成交额 ≥ 10 万 USDT 的 USDT 交易对；点击任意行查看 K 线详情。
      </p>
    </div>
  );
}
