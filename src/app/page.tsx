'use client';

import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAnomalies, useStats, useTickers } from '@/hooks/use-market';
import { fmtAgo } from '@/lib/format';
import { AnomalyFeed } from '@/components/market/anomaly-feed';
import { CoinDialog } from '@/components/market/coin-dialog';
import { HotTable } from '@/components/market/hot-table';
import { Movers } from '@/components/market/movers';
import { StatsBar } from '@/components/market/stats-bar';
import { ScannerView } from '@/components/scanner/scanner-view';
import { cn } from '@/lib/utils';
import { Flame, LineChart, Radar, ScanLine, Zap } from 'lucide-react';

type View = 'radar' | 'scanner';

function LiveStatus({ ts }: { ts: number | null }) {
  const [now, setNow] = useState<number | null>(null);
  // 客户端挂载后每秒刷新「x 秒前」
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-up text-up" />
      <span className="hidden md:inline">实时更新 · 每 4 秒</span>
      <span className="tabular-nums">{ts ? fmtAgo(ts) : '连接中…'}</span>
      <span className="sr-only">{now ?? ''}</span>
    </div>
  );
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const btn = (v: View) =>
    cn(
      'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-all sm:px-3 sm:text-sm',
      view === v
        ? 'bg-gold text-background shadow-sm'
        : 'text-muted-foreground hover:text-foreground',
    );
  return (
    <nav
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-secondary/60 p-1"
      aria-label="页面切换"
    >
      <button className={btn('radar')} onClick={() => onChange('radar')} aria-current={view === 'radar'}>
        <Radar className="h-4 w-4" />
        <span className="hidden sm:inline">行情雷达</span>
      </button>
      <button
        className={btn('scanner')}
        onClick={() => onChange('scanner')}
        aria-current={view === 'scanner'}
      >
        <ScanLine className="h-4 w-4" />
        <span className="hidden sm:inline">机会扫描 · 模拟盘</span>
      </button>
    </nav>
  );
}

function RadarView() {
  const tickers = useTickers();
  const anomalies = useAnomalies();
  const stats = useStats();

  const [tab, setTab] = useState('hot');
  const [selected, setSelected] = useState<string | null>(null);

  const gotoAnomalies = () => setTab('anomalies');

  return (
    <>
      <div className="space-y-4 sm:space-y-5">
        <StatsBar
          stats={stats.data}
          isLoading={stats.isLoading}
          isError={stats.isError}
          onGotoAnomalies={gotoAnomalies}
        />

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid h-10 w-full grid-cols-3 sm:w-[420px]">
            <TabsTrigger value="hot" className="gap-1.5">
              <Flame className="h-4 w-4" />
              热门币种
            </TabsTrigger>
            <TabsTrigger value="movers" className="gap-1.5">
              <LineChart className="h-4 w-4" />
              涨跌幅榜
            </TabsTrigger>
            <TabsTrigger value="anomalies" className="gap-1.5">
              <Zap className="h-4 w-4" />
              异动监控
            </TabsTrigger>
          </TabsList>

          <TabsContent value="hot" className="mt-4">
            <HotTable
              tickers={tickers.data?.data ?? []}
              loading={tickers.isLoading}
              onSelect={setSelected}
            />
          </TabsContent>

          <TabsContent value="movers" className="mt-4">
            <Movers
              tickers={tickers.data?.data ?? []}
              loading={tickers.isLoading}
              onSelect={setSelected}
            />
          </TabsContent>

          <TabsContent value="anomalies" className="mt-4">
            <AnomalyFeed
              events={anomalies.data?.data ?? []}
              loading={anomalies.isLoading}
              symbolsTracked={stats.data?.symbolsTracked ?? 0}
              onSelect={setSelected}
            />
          </TabsContent>
        </Tabs>
      </div>
      <CoinDialog symbol={selected} onClose={() => setSelected(null)} />
    </>
  );
}

export default function Page() {
  const tickers = useTickers();
  const [view, setView] = useState<View>('radar');

  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-3 py-3 sm:gap-3 sm:px-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/15">
            <Radar className="h-5 w-5 text-gold" />
          </div>
          <div className="hidden min-w-0 lg:block">
            <h1 className="truncate text-base font-bold leading-tight sm:text-lg">
              币安热点雷达
            </h1>
            <p className="text-xs text-muted-foreground">
              Binance Hot Radar · 热门币种 / 涨跌幅 / 异动 / 机会扫描
            </p>
          </div>
          <div className="mx-auto lg:mx-0 lg:ml-2">
            <ViewSwitch view={view} onChange={setView} />
          </div>
          <div className="ml-auto hidden sm:block">
            <LiveStatus ts={tickers.dataUpdatedAt || null} />
          </div>
        </div>
      </header>

      {/* 主体 */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-6 sm:py-6">
        {view === 'radar' ? <RadarView /> : <ScannerView />}
      </main>

      {/* 页脚 */}
      <footer className={cn('mt-auto border-t border-border/70')}>
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-1 px-3 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span>
            数据来源：币安公开行情接口（每 5 秒采集）· 异动与模拟盘数据本地持久化
          </span>
          <span>行情数据仅供参考，模拟盘无真实资金 · 交易有风险，入市需谨慎</span>
        </div>
      </footer>
    </div>
  );
}
