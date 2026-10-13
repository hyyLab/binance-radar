'use client';

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { useOpenPosition, usePaperAccount } from '@/hooks/use-scanner';
import { useTickers } from '@/hooks/use-market';
import { PAPER_MIN_MARGIN, TAKER_FEE, liqPriceFor } from '@/lib/market/futures';
import { fmtPrice, fmtQty } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';

const LEV_PRESETS = [5, 10, 20];
const MARGIN_PRESETS = [0.1, 0.25, 0.5, 1];

export interface TradeIntent {
  open: boolean;
  symbol?: string;
  side?: 'LONG' | 'SHORT';
}

export function TradeModal({
  intent,
  onClose,
}: {
  intent: TradeIntent | null;
  onClose: () => void;
}) {
  const { data: tickersResp } = useTickers();
  const { data: paper } = usePaperAccount();
  const openMutation = useOpenPosition();

  const allTickers = tickersResp?.data ?? [];
  const hot = useMemo(
    () => [...allTickers].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h),
    [allTickers],
  );

  const [symbol, setSymbol] = useState(intent?.symbol ?? 'BTCUSDT');
  const [side, setSide] = useState<'LONG' | 'SHORT'>(intent?.side ?? 'LONG');
  const [leverage, setLeverage] = useState(20); // 默认 20x
  const [pctIdx, setPctIdx] = useState(1); // 默认 25%
  const [customMargin, setCustomMargin] = useState('');
  const [search, setSearch] = useState('');

  const ticker = allTickers.find((t) => t.symbol === symbol);
  const price = ticker?.price ?? 0;
  const balance = paper?.account.balance ?? 0;

  // 最大可开保证金：需满足 margin + margin×杠杆×费率 ≤ 余额
  // 即 margin ≤ 余额 / (1 + 杠杆×费率)，向下取整到分，保证 100% 也能直接成交
  const maxMargin =
    balance > 0 ? Math.floor((balance / (1 + leverage * TAKER_FEE)) * 100) / 100 : 0;

  const suggestions = useMemo(() => {
    const kw = search.trim().toUpperCase();
    const src = kw ? hot.filter((t) => t.symbol.includes(kw)) : hot;
    return src.slice(0, 8);
  }, [hot, search]);

  const presetMargin = balance > 0 ? Math.min(balance * MARGIN_PRESETS[pctIdx], maxMargin) : 0;
  const margin = customMargin.trim() !== '' ? Number(customMargin) : presetMargin;
  const marginValid =
    Number.isFinite(margin) && margin >= PAPER_MIN_MARGIN && margin <= maxMargin + 1e-9;
  const notional = marginValid ? margin * leverage : 0;
  const fee = notional * TAKER_FEE;
  const qty = price > 0 && notional > 0 ? notional / price : 0;
  // 强平价：币安逐仓精确式（分层维持保证金率，同服务端 futures.liqPriceFor）
  const liqPrice =
    price > 0 && marginValid
      ? liqPriceFor({ symbol, side, entry: price, leverage, notional })
      : 0;

  const canSubmit =
    marginValid && price > 0 && !!ticker && !openMutation.isPending && margin + fee <= balance + 1e-9;

  const submit = () => {
    if (!canSubmit || !ticker) return;
    openMutation.mutate(
      { symbol: ticker.symbol, side, leverage, margin },
      { onSuccess: () => onClose() },
    );
  };

  const inputCls =
    'w-full rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-gold/60';

  return (
    <Dialog open={!!intent?.open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(480px,95vw)] overflow-y-auto custom-scroll">
        <DialogTitle className="text-lg font-bold">模拟建仓 · 市价单</DialogTitle>
        <DialogDescription className="text-xs">
          以最新成交价即时成交 · 初始资金 10 USDT · 最高 20× 杠杆 · 币安 USDT-M 合约规则
        </DialogDescription>

        {/* 币种选择 */}
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="trade-symbol">
            交易对
          </label>
          <Input
            id="trade-symbol"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={symbol ? `${symbol.replace(/USDT$/, '')}/USDT（点击下方可切换）` : '搜索币种…'}
            className="h-9"
            aria-label="搜索交易对"
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {suggestions.map((t) => (
              <button
                key={t.symbol}
                onClick={() => {
                  setSymbol(t.symbol);
                  setSearch('');
                }}
                className={cn(
                  'rounded border px-2 py-0.5 text-xs font-semibold transition-colors',
                  t.symbol === symbol
                    ? 'border-gold/60 bg-gold/15 text-gold'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t.base}
              </button>
            ))}
          </div>
        </div>

        {/* 现价 */}
        {ticker && price > 0 && (
          <div className="flex items-center justify-between rounded-md bg-secondary/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">最新成交价</span>
            <span className="font-bold tabular-nums">{fmtPrice(price)}</span>
            <span className={cn('text-xs tabular-nums', ticker.change24h >= 0 ? 'text-up' : 'text-down')}>
              24h {ticker.change24h >= 0 ? '+' : ''}
              {ticker.change24h.toFixed(2)}%
            </span>
          </div>
        )}

        {/* 方向 */}
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">方向（一键买入 / 一键卖出）</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setSide('LONG')}
              aria-pressed={side === 'LONG'}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border py-2.5 text-sm font-bold transition-all',
                side === 'LONG'
                  ? 'border-up bg-up text-background'
                  : 'border-border text-muted-foreground hover:border-up/50 hover:text-up',
              )}
            >
              <TrendingUp className="h-4 w-4" />
              买入做多
            </button>
            <button
              onClick={() => setSide('SHORT')}
              aria-pressed={side === 'SHORT'}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border py-2.5 text-sm font-bold transition-all',
                side === 'SHORT'
                  ? 'border-down bg-down text-background'
                  : 'border-border text-muted-foreground hover:border-down/50 hover:text-down',
              )}
            >
              <TrendingDown className="h-4 w-4" />
              卖出做空
            </button>
          </div>
        </div>

        {/* 杠杆 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">杠杆倍数</span>
            <span className="font-bold tabular-nums text-gold">{leverage}×</span>
          </div>
          <Slider
            value={[leverage]}
            onValueChange={(v) => setLeverage(v[0] ?? 1)}
            min={1}
            max={20}
            step={1}
            aria-label="杠杆倍数"
          />
          <div className="mt-1.5 flex gap-1.5">
            {LEV_PRESETS.map((l) => (
              <button
                key={l}
                onClick={() => setLeverage(l)}
                className={cn(
                  'flex-1 rounded border py-1 text-xs font-semibold transition-colors',
                  leverage === l
                    ? 'border-gold/60 bg-gold/15 text-gold'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {l}×
              </button>
            ))}
          </div>
        </div>

        {/* 保证金 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">保证金（USDT）</span>
            <span className="tabular-nums text-muted-foreground">
              可用 {balance.toFixed(2)} · 最大可开
              <span className="ml-1 font-semibold text-gold">{maxMargin.toFixed(2)}</span>
            </span>
          </div>
          <div className="flex gap-1.5">
            {MARGIN_PRESETS.map((p, i) => (
              <button
                key={p}
                onClick={() => {
                  setPctIdx(i);
                  setCustomMargin('');
                }}
                className={cn(
                  'flex-1 rounded border py-1 text-xs font-semibold transition-colors',
                  customMargin === '' && pctIdx === i
                    ? 'border-gold/60 bg-gold/15 text-gold'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {p >= 1 ? '最大' : `${p * 100}%`}
              </button>
            ))}
          </div>
          <input
            value={customMargin}
            onChange={(e) => setCustomMargin(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder={`自定义（${PAPER_MIN_MARGIN} ~ ${maxMargin.toFixed(2)}，当前 ${marginValid ? margin.toFixed(2) : '—'}）`}
            className={cn(inputCls, 'mt-1.5')}
            inputMode="decimal"
            aria-label="自定义保证金"
          />
        </div>

        {/* 计算 */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-secondary/30 px-3 py-2.5 text-xs tabular-nums">
          <div className="flex justify-between">
            <span className="text-muted-foreground">名义价值</span>
            <span className="font-semibold">{notional.toFixed(2)} U</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">预估数量</span>
            <span className="font-semibold">{qty > 0 ? fmtQty(qty) : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">开仓手续费</span>
            <span className="font-semibold">{fee > 0 ? fee.toFixed(3) : '—'} U</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">预估强平价</span>
            <span className="font-semibold text-down">{liqPrice > 0 ? fmtPrice(liqPrice) : '—'}</span>
          </div>
        </div>

        {!marginValid && balance > 0 && (
          <div className="flex items-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-xs text-down">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {balance < PAPER_MIN_MARGIN
              ? `可用余额不足 ${PAPER_MIN_MARGIN} USDT，请先平仓回笼资金或重置账户`
              : margin > maxMargin
                ? `超过最大可开保证金 ${maxMargin.toFixed(2)} U（需预留开仓手续费），已自动拉满可直接成交`
                : `保证金至少 ${PAPER_MIN_MARGIN} USDT`}
          </div>
        )}

        {/* 一键成交 */}
        <button
          onClick={submit}
          disabled={!canSubmit}
          className={cn(
            'w-full rounded-md py-3 text-base font-bold transition-all disabled:cursor-not-allowed disabled:opacity-40',
            side === 'LONG'
              ? 'bg-up text-background hover:opacity-90'
              : 'bg-down text-background hover:opacity-90',
          )}
        >
          {openMutation.isPending
            ? '下单中…'
            : side === 'LONG'
              ? `一键买入做多 ${symbol.replace(/USDT$/, '')}`
              : `一键卖出做空 ${symbol.replace(/USDT$/, '')}`}
        </button>
        <p className="text-center text-[11px] text-muted-foreground">
          模拟盘 · 无真实资金 · Taker 费率 0.05% / Maker 0.02%（币安 USDT-M）· 触及强平价自动清算
        </p>
      </DialogContent>
    </Dialog>
  );
}
