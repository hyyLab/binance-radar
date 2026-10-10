// ---------- 机会扫描引擎 ----------
// 每 2 分钟：Top120 币种 × 3m/5m/15m K 线 → 均线支撑/压力机会（评分 ≥3 输出）
// 每 5 分钟：Top120 币种 4h K 线 → 大级别支撑/压力（分形聚类）
// 单例（globalThis 驻留），扫描结果缓存在内存

import { bFetch, type KlineRow } from './binance';
import { collector } from './collector';
import { analyzeLevels, analyzeMa, type MaSignal, type ScannerTF, type SymbolLevels } from './indicators';

const SCAN_TOP = 160;
const SIGNAL_INTERVAL_MS = 2 * 60_000;
const LEVEL_INTERVAL_MS = 5 * 60_000;
const MIN_QV_UNIVERSE = 1_000_000; // 参与涨幅/跌幅榜统计的最低 24h 成交额
const TOP_GAINERS = 40; // 涨幅榜入扫数量
const TOP_LOSERS = 40; // 跌幅榜入扫数量
const ANOMALY_LOOKBACK_MS = 4 * 3600_000; // 异动币种回溯窗口
const CONCURRENCY = 8;
const TF_LIST: ScannerTF[] = ['3m', '5m', '15m'];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export interface ScannerStatus {
  scanning: boolean;
  levelScanning: boolean;
  lastSignalScanAt: number;
  lastLevelScanAt: number;
  coverage: number;
  universe: {
    gainers: number; // 涨幅榜入扫数量
    losers: number; // 跌幅榜入扫数量
    anomalies: number; // 异动/放量币种数量
  };
  startedAt: number;
}

export class MarketScanner {
  private signals: MaSignal[] = [];
  private levels: SymbolLevels[] = [];
  private scanning = false;
  private levelScanning = false;
  private lastSignalScanAt = 0;
  private lastLevelScanAt = 0;
  private started = false;
  private starting: Promise<void> | null = null;
  private universeCache: string[] = [];
  private universeStats = { gainers: 0, losers: 0, anomalies: 0 };
  private universeAt = 0;
  private signalTimer: ReturnType<typeof setInterval> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  meta = { startedAt: 0, lastError: '' };

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, sleep(8000)]);
      return;
    }
    this.started = true;
    this.meta.startedAt = Date.now();
    this.starting = (async () => {
      await collector.ensureStarted();
      // 等待 24h 行情就绪（需要币种列表与成交额）
      for (let i = 0; i < 30 && collector.getStats().last24hOk === 0; i++) await sleep(500);
      this.signalTimer = setInterval(() => void this.scanSignals(), SIGNAL_INTERVAL_MS);
      this.levelTimer = setInterval(() => void this.scanLevels(), LEVEL_INTERVAL_MS);
      // 首轮：先扫均线信号，完成后立即扫大级别支撑/压力
      await this.scanSignals().catch(() => {});
      void this.scanLevels();
    })();
    await Promise.race([this.starting, sleep(8000)]);
  }

  getStatus(): ScannerStatus {
    return {
      scanning: this.scanning,
      levelScanning: this.levelScanning,
      lastSignalScanAt: this.lastSignalScanAt,
      lastLevelScanAt: this.lastLevelScanAt,
      coverage: this.topSymbols().length,
      universe: this.universeStats,
      startedAt: this.meta.startedAt,
    };
  }

  getSignals(): MaSignal[] {
    return this.signals;
  }

  getLevels(): SymbolLevels[] {
    return this.levels;
  }

  /**
   * 扫描范围：聚焦机会密集的币种 ——
   *  1) 24h 涨幅榜 Top40（做多动量集中区）
   *  2) 24h 跌幅榜 Top40（做空动量集中区）
   *  3) 近 4 小时触发过异动的币种（拉升/跳水/放量/新高新低）+ 实时放量（量比≥4）
   * 每 30 秒重建一次候选池。
   */
  private buildUniverse(): { symbols: string[]; gainers: number; losers: number; anomalies: number } {
    const tickers = collector.getTickers().filter((t) => t.quoteVolume24h >= MIN_QV_UNIVERSE);
    const seen = new Set<string>();
    const symbols: string[] = [];
    const push = (t: { symbol: string }) => {
      if (!seen.has(t.symbol)) {
        seen.add(t.symbol);
        symbols.push(t.symbol);
      }
    };

    // 1) 涨幅榜 Top40
    const gainers = [...tickers]
      .filter((t) => t.change24h > 0)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, TOP_GAINERS);
    gainers.forEach(push);

    // 2) 跌幅榜 Top40
    const losers = [...tickers]
      .filter((t) => t.change24h < 0)
      .sort((a, b) => a.change24h - b.change24h)
      .slice(0, TOP_LOSERS);
    losers.forEach(push);

    // 3) 近 4 小时异动币种
    const cutoff = Date.now() - ANOMALY_LOOKBACK_MS;
    const anomalySymbols = new Set<string>();
    for (const ev of collector.getMemoryAnomalies()) {
      if (new Date(ev.createdAt).getTime() >= cutoff) anomalySymbols.add(ev.symbol);
    }
    // 服务重启后内存可能为空：用热门池中的实时放量（SURGE）作为补充
    for (const entry of collector.getHotPoolEntries()) {
      if (entry.tags.includes('SURGE')) anomalySymbols.add(entry.symbol);
    }
    // 异动币种也需在行情列表内（有价格/成交额数据）
    const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));
    for (const s of anomalySymbols) {
      const t = tickerMap.get(s);
      if (t) push(t);
    }

    return {
      symbols: symbols.slice(0, SCAN_TOP),
      gainers: gainers.length,
      losers: losers.length,
      anomalies: Math.min(anomalySymbols.size, SCAN_TOP),
    };
  }

  private topSymbols() {
    const now = Date.now();
    if (now - this.universeAt > 30_000 || this.universeCache.length === 0) {
      const u = this.buildUniverse();
      this.universeCache = u.symbols;
      this.universeStats = { gainers: u.gainers, losers: u.losers, anomalies: u.anomalies };
      this.universeAt = now;
    }
    const map = new Map(collector.getTickers().map((t) => [t.symbol, t]));
    const picked: NonNullable<ReturnType<typeof map.get>>[] = [];
    for (const s of this.universeCache) {
      const t = map.get(s);
      if (t) picked.push(t);
    }
    return picked;
  }

  private async scanSignals(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const symbols = this.topSymbols();
      const now = Date.now();
      const out: MaSignal[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < symbols.length) {
          const t = symbols[cursor++];
          for (const tf of TF_LIST) {
            try {
              const kl = await bFetch<KlineRow[]>('/api/v3/klines', {
                symbol: t.symbol,
                interval: tf,
                limit: 100,
              });
              const sig = analyzeMa(tf, t.symbol, t.base, kl, {
                change24h: t.change24h,
                quoteVolume24h: t.quoteVolume24h,
                now,
              });
              if (sig) out.push(sig);
            } catch {
              // 单币种/周期失败忽略
            }
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      this.signals = out
        .sort((a, b) => b.score - a.score || Math.abs(a.distancePct) - Math.abs(b.distancePct))
        .slice(0, 60);
      this.lastSignalScanAt = Date.now();
      this.meta.lastError = '';
    } catch (e) {
      this.meta.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.scanning = false;
    }
  }

  private async scanLevels(): Promise<void> {
    if (this.levelScanning) return;
    this.levelScanning = true;
    try {
      const symbols = this.topSymbols();
      const out: SymbolLevels[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < symbols.length) {
          const t = symbols[cursor++];
          try {
            const kl = await bFetch<KlineRow[]>('/api/v3/klines', {
              symbol: t.symbol,
              interval: '4h',
              limit: 120,
            });
            const lv = analyzeLevels(
              t.symbol,
              t.base,
              {
                price: t.price,
                change24h: t.change24h,
                quoteVolume24h: t.quoteVolume24h,
              },
              kl,
            );
            if (lv) out.push(lv);
          } catch {
            // 单币种失败忽略
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      this.levels = out;
      this.lastLevelScanAt = Date.now();
    } catch (e) {
      this.meta.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.levelScanning = false;
    }
  }
}

const g = globalThis as typeof globalThis & {
  __binanceRadarScanner?: MarketScanner;
};

export const scanner: MarketScanner = (g.__binanceRadarScanner ??= new MarketScanner());
