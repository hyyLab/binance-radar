'use client';

import { useState } from 'react';
import { useLevels, usePaperAccount, useSignals } from '@/hooks/use-scanner';
import { fmtAgo } from '@/lib/format';
import { MajorLevels } from './major-levels';
import { PaperPanel } from './paper-panel';
import { SignalList } from './signal-list';
import { AnomalyMonitor } from './anomaly-monitor';
import { TradeModal, type TradeIntent } from './trade-modal';
import { CoinDialog } from '@/components/market/coin-dialog';
import { ScanLine } from 'lucide-react';

export function ScannerView() {
  const signals = useSignals();
  const levels = useLevels();
  const paper = usePaperAccount();

  const [tradeIntent, setTradeIntent] = useState<TradeIntent | null>(null);
  const [tradeKey, setTradeKey] = useState(0); // 每次新开仓意图重挂载弹窗（预填生效）
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  const status = signals.data?.status;
  const lastScan = status?.lastSignalScanAt ?? 0;

  const openTrade = (symbol: string, side: 'LONG' | 'SHORT') => {
    setTradeIntent({ open: true, symbol, side });
    setTradeKey((k) => k + 1);
  };
  const openManual = () => {
    setTradeIntent({ open: true });
    setTradeKey((k) => k + 1);
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* 扫描状态条 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/70 bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <ScanLine className="h-4 w-4 text-gold" />
          机会扫描器
        </span>
        <span>
          扫描 24h 涨幅榜 / 跌幅榜 Top20 + 近 4 小时异动币种（已剔除股票 / 商品代币）·
          涨幅榜出做多、跌幅榜出做空、异动双向 · 榜单每 10 分钟重建、新进榜实时并入 ·
          当前覆盖 {status?.coverage ?? 0} 个
          {status?.universe
            ? `（涨 ${status.universe.gainers} / 跌 ${status.universe.losers} / 异动 ${status.universe.anomalies}）`
            : ''}
        </span>
        {status?.scanning ? (
          <span className="flex items-center gap-1.5 text-gold">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
            信号扫描中…
          </span>
        ) : (
          <span className="tabular-nums">信号上次扫描 {fmtAgo(lastScan)}</span>
        )}
        {status?.levelScanning && <span className="text-gold">支撑位扫描中…</span>}
      </div>

      {/* 信号（左 2/3）+ 大级别支撑（右 1/3） */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SignalList
            signals={signals.data?.data ?? []}
            loading={signals.isLoading}
            scanning={!!status?.scanning}
            onTrade={openTrade}
            onSelectSymbol={setSelectedSymbol}
          />
        </div>
        <MajorLevels
          levels={levels.data?.data ?? []}
          loading={levels.isLoading}
          onTrade={openTrade}
          onSelectSymbol={setSelectedSymbol}
        />
      </div>

      {/* 异动监控 · 一键交易（直接按建议方向开仓） */}
      <AnomalyMonitor onTrade={openTrade} onSelectSymbol={setSelectedSymbol} />

      {/* 模拟建仓系统 */}
      <PaperPanel
        data={paper.data}
        loading={paper.isLoading}
        onSelectSymbol={setSelectedSymbol}
        onManualTrade={openManual}
      />

      <TradeModal key={tradeKey} intent={tradeIntent} onClose={() => setTradeIntent(null)} />
      <CoinDialog symbol={selectedSymbol} onClose={() => setSelectedSymbol(null)} />
    </div>
  );
}
