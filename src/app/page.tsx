'use client';

import { useState } from 'react';
import { ScannerView } from '@/components/scanner/scanner-view';
import { EnhancedView } from '@/components/enhanced/enhanced-view';
import { cn } from '@/lib/utils';
import { Radar, ScanLine, Zap } from 'lucide-react';

type Section = 'scanner' | 'enhanced';

function SectionSwitch({ section, onChange }: { section: Section; onChange: (v: Section) => void }) {
  const btn = (v: Section) =>
    cn(
      'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-all sm:px-3 sm:text-sm',
      section === v
        ? 'bg-gold text-background shadow-sm'
        : 'text-muted-foreground hover:text-foreground',
    );
  return (
    <nav
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-secondary/60 p-1"
      aria-label="专题页切换"
    >
      <button
        className={btn('scanner')}
        onClick={() => onChange('scanner')}
        aria-current={section === 'scanner'}
      >
        <ScanLine className="h-4 w-4" />
        <span>模拟盘</span>
      </button>
      <button
        className={btn('enhanced')}
        onClick={() => onChange('enhanced')}
        aria-current={section === 'enhanced'}
      >
        <Zap className="h-4 w-4" />
        <span className="hidden xs:inline sm:inline">升级版异动交易</span>
      </button>
    </nav>
  );
}

export default function Page() {
  const [section, setSection] = useState<Section>('scanner');

  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-3 py-3 sm:gap-3 sm:px-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/15">
            <Radar className="h-5 w-5 text-gold" />
          </div>
          <div className="hidden min-w-0 lg:block">
            <h1 className="truncate text-base font-bold leading-tight sm:text-lg">币安热点雷达</h1>
            <p className="text-xs text-muted-foreground">异动监控 · 一键交易 · 模拟盘</p>
          </div>
          <div className="mx-auto lg:mx-0 lg:ml-2">
            <SectionSwitch section={section} onChange={setSection} />
          </div>
        </div>
      </header>

      {/* 主体 */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-6 sm:py-6">
        {section === 'scanner' ? <ScannerView /> : <EnhancedView />}
      </main>

      {/* 页脚 */}
      <footer className={cn('mt-auto border-t border-border/70')}>
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-1 px-3 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span>
            数据来源：币安现货 · 合约多源（币安U本位 / Bybit / Gate，币安优先，每 5 秒采集）· 异动与模拟盘数据本地持久化
          </span>
          <span>行情数据仅供参考，模拟盘无真实资金 · 交易有风险，入市需谨慎</span>
        </div>
      </footer>
    </div>
  );
}
