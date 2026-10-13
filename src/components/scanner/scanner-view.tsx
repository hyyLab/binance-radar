'use client';

// 机会扫描器信号区（均线支撑位机会 / 大级别支撑·做多参考、大级别压力·做空参考）
// 已按需求整体移除，本页签仅保留：异动监控（一键交易）+ 模拟建仓系统。

import { useState } from 'react';
import { usePaperAccount } from '@/hooks/use-scanner';
import { PaperPanel } from './paper-panel';
import { AnomalyMonitor } from './anomaly-monitor';
import { TradeModal, type TradeIntent } from './trade-modal';
import { CoinDialog } from '@/components/market/coin-dialog';

export function ScannerView() {
  const paper = usePaperAccount();

  const [tradeIntent, setTradeIntent] = useState<TradeIntent | null>(null);
  const [tradeKey, setTradeKey] = useState(0); // 每次新开仓意图重挂载弹窗（预填生效）
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

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
