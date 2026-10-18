'use client';

import { EnhancedView } from '@/components/enhanced/enhanced-view';
import { cn } from '@/lib/utils';
import { Radar } from 'lucide-react';

export default function Page() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-3 py-3 sm:gap-3 sm:px-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/15">
            <Radar className="h-5 w-5 text-gold" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight sm:text-lg">binance热点雷达</h1>
            <p className="text-xs text-muted-foreground">USDT-M 合约异动 · 一键交易 · 模拟建仓</p>
          </div>
        </div>
      </header>

      {/* 主体（单页：升级版异动交易 + 模拟建仓系统） */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-6 sm:py-6">
        <EnhancedView />
      </main>

      {/* 页脚 */}
      <footer className={cn('mt-auto border-t border-border/70')}>
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-1 px-3 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span>
            数据来源：合约多源分片供价（binance U 本位 Top125 / Bybit / Gate 平分，每 5 秒采集）· 异动与模拟盘数据本地持久化
          </span>
          <span>行情数据仅供参考，模拟盘无真实资金 · 交易有风险，入市需谨慎</span>
        </div>
      </footer>
    </div>
  );
}
