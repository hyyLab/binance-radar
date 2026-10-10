// ---------- 机会扫描引擎 ----------
// 每 2 分钟：Top120 币种 × 3m/5m/15m K 线 → 均线支撑/压力机会（评分 ≥3 输出）
// 每 5 分钟：Top120 币种 4h K 线 → 大级别支撑/压力（分形聚类）
// 单例（globalThis 驻留），扫描结果缓存在内存

import { bFetch, type KlineRow } from './binance';
import { collector } from './collector';
import { analyzeLevels, analyzeMa, type MaSignal, type ScannerTF, type SymbolLevels } from './indicators';

const SCAN_TOP = 20; // 只扫交易最活跃的前 20 个虚拟币
const SIGNAL_INTERVAL_MS = 2 * 60_000;
const LEVEL_INTERVAL_MS = 5 * 60_000;
const MIN_QV_UNIVERSE = 1_000_000; // 参与活跃度排序的最低 24h 成交额
const CONCURRENCY = 8;
const TF_LIST: ScannerTF[] = ['3m', '5m', '15m'];

// 代币化股票 / ETF：真实股票代码表（Binance 命名为 代码+B，如 MSTRB / CRCLB / SNDKB / SOXLB）
const STOCK_TICKERS = new Set([
  'MSTR', 'CRCL', 'HOOD', 'TSLA', 'AAPL', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'MSFT',
  'META', 'COIN', 'PLTR', 'ORCL', 'NFLX', 'AVGO', 'LLY', 'JPM', 'ABNB', 'SBET',
  'DFDV', 'CEP', 'SMLR', 'BTBT', 'SPY', 'QQQ', 'SOXL', 'SPCX', 'SNDK',
]);
// 其它非虚拟币：贵金属商品代币、稳定币
const EXTRA_EXCLUDED_BASES = new Set(['XAUT', 'XAUTB', 'PAXG', 'PAXGB', 'KAU', 'KAUB', 'RLUSD']);

function isExcludedBase(base: string): boolean {
  if (EXTRA_EXCLUDED_BASES.has(base)) return true;
  if (STOCK_TICKERS.has(base)) return true;
  // 股票代币命名规则：股票代码 + B 后缀
  if (base.endsWith('B') && STOCK_TICKERS.has(base.slice(0, -1))) return true;
  return false;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export interface ScannerStatus {
  scanning: boolean;
  levelScanning: boolean;
  lastSignalScanAt: number;
  lastLevelScanAt: number;
  coverage: number;
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
   * 扫描范围：交易最活跃（24h 成交额）的前 20 个虚拟币，
   * 剔除代币化股票 / 指数 ETF / 贵金属商品代币 / 稳定币。
   */
  private topSymbols() {
    return collector
      .getTickers()
      .filter((t) => t.quoteVolume24h >= MIN_QV_UNIVERSE && !isExcludedBase(t.base))
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, SCAN_TOP);
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
