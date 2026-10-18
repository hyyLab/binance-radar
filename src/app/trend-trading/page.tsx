'use client';

// ---------- 趋势自动模拟交易 · 独立页面（Task 54 §5） ----------
// 与主雷达页（异动交易/手动模拟盘）分离：自动持仓不与手动交易混在同一组流水里。

import Link from 'next/link';
import { Radar } from 'lucide-react';
import { TrendTradeView } from '@/components/trend-trade/trend-trade-view';

export default function TrendTradingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶栏（与主页面同构 + 双向导航） */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-3 py-3 sm:gap-3 sm:px-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/15">
            <Radar className="h-5 w-5 text-gold" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight sm:text-lg">binance热点雷达 · 趋势交易</h1>
            <p className="text-xs text-muted-foreground">高波动趋势识别 · 自动模拟盘（独立账户）· 纯模拟</p>
          </div>
          <Link
            href="/"
            className="ml-auto inline-flex h-9 items-center rounded border border-border px-3 text-xs text-muted-foreground hover:text-foreground sm:h-8"
          >
            ← 返回异动雷达
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-6 sm:py-6">
        <TrendTradeView />
      </main>

      <footer className="mt-auto border-t border-border/70">
        <div className="mx-auto w-full max-w-7xl px-3 py-4 text-center text-xs text-muted-foreground sm:px-6">
          趋势识别基于 Universal Trend Engine + 波动率/效率特征（1m 主周期 + 5m/15m 过滤）· 参数未经历史回放校准 · 不构成投资建议
        </div>
      </footer>
    </div>
  );
}
