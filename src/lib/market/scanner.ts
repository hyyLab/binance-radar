// ---------- 机会扫描引擎 ----------
// 每 2 分钟：扫描宇宙 × 3m/5m/15m K 线 → 均线支撑/压力机会（评分 ≥3 输出）
// 每 5 分钟：4h K 线 → 大级别支撑/压力（分形聚类）
// 扫描宇宙 = 24h 涨幅榜 Top20 + 跌幅榜 Top20 + 近 4 小时异动币种（剔除代币化股票/商品代币）
//   - 榜单每 10 分钟全量重建（刚开始反抽的新币及时纳入）
//   - 两次重建之间：新进榜币种 / 新异动币种增量并入，不驱逐已有成员
//   - 信号方向随榜单：涨幅榜 → 只出做多（回踩支撑）；跌幅榜 → 只出做空（反抽压力）；仅异动 → 双向
// 单例（globalThis 驻留），扫描结果缓存在内存

import { bFetch, type KlineRow } from './binance';
import { collector } from './collector';
import { analyzeLevels, analyzeMa, type MaSignal, type ScannerTF, type SymbolLevels } from './indicators';
import type { ScannerStatusDTO, TickerSnapshot } from './types';

const GAINERS_TOP = 20; // 涨幅榜取前 20
const LOSERS_TOP = 20; // 跌幅榜取前 20
const UNIVERSE_REFRESH_MS = 10 * 60_000; // 涨跌幅榜单每 10 分钟全量重建
const ANOMALY_WINDOW_MS = 4 * 60 * 60_000; // 近 4 小时有异动的币种纳入扫描
const MAX_UNIVERSE = 200; // 宇宙成员上限（防止增量并入无限膨胀）
const SIGNAL_INTERVAL_MS = 2 * 60_000;
const LEVEL_INTERVAL_MS = 5 * 60_000;
const MIN_QV_UNIVERSE = 1_000_000; // 进榜门槛：24h 成交额 ≥ 100 万 USDT
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

type UniverseTag = 'UP' | 'DOWN' | 'ANOM';

interface UniverseMember {
  tags: Set<UniverseTag>; // 入选来源（可多标签）
  joinedAt: number;
}

export class MarketScanner {
  private signals: MaSignal[] = [];
  private levels: SymbolLevels[] = [];
  private universe = new Map<string, UniverseMember>();
  private anomalySeen = new Map<string, number>(); // symbol -> 最近一次观测到异动的时间
  private lastUniverseRefreshAt = 0;
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

  getStatus(): ScannerStatusDTO {
    const members = this.universeTickers();
    let gainers = 0;
    let losers = 0;
    let anomalies = 0;
    for (const t of members) {
      const m = this.universe.get(t.symbol);
      if (!m) continue;
      if (m.tags.has('UP')) gainers++;
      if (m.tags.has('DOWN')) losers++;
      if (m.tags.has('ANOM')) anomalies++;
    }
    return {
      scanning: this.scanning,
      levelScanning: this.levelScanning,
      lastSignalScanAt: this.lastSignalScanAt,
      lastLevelScanAt: this.lastLevelScanAt,
      coverage: members.length,
      universe: {
        gainers,
        losers,
        anomalies,
        total: members.length,
        refreshIntervalMin: UNIVERSE_REFRESH_MS / 60_000,
        lastRefreshAt: this.lastUniverseRefreshAt,
        nextRefreshAt: this.lastUniverseRefreshAt + UNIVERSE_REFRESH_MS,
      },
    };
  }

  getSignals(): MaSignal[] {
    return this.signals;
  }

  getLevels(): SymbolLevels[] {
    return this.levels;
  }

  /** 排行榜快照：24h 涨幅榜 / 跌幅榜（剔除代币化股票 / 商品代币与低成交额币种） */
  private boards() {
    const rows = collector
      .getTickers()
      .filter((t) => t.quoteVolume24h >= MIN_QV_UNIVERSE && !isExcludedBase(t.base));
    const gainers = rows
      .filter((t) => t.change24h > 0)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, GAINERS_TOP);
    const losers = rows
      .filter((t) => t.change24h < 0)
      .sort((a, b) => a.change24h - b.change24h)
      .slice(0, LOSERS_TOP);
    return { gainers, losers };
  }

  /**
   * 刷新扫描宇宙：
   *  - 每 10 分钟全量重建一次（涨幅榜 Top20 + 跌幅榜 Top20 + 近 4h 异动）
   *  - 两次重建之间增量并入新进榜 / 新异动币种，已有成员不驱逐（保证信号生命周期完整）
   *  - 异动观测记忆化：异动流水环形缓冲仅 300 条，按币种记 4h，避免高频期遗漏
   */
  private refreshUniverse(now: number) {
    for (const ev of collector.getMemoryAnomalies()) {
      const t = Date.parse(ev.createdAt);
      if (!Number.isFinite(t) || now - t > ANOMALY_WINDOW_MS) continue;
      const prev = this.anomalySeen.get(ev.symbol);
      if (!prev || prev < t) this.anomalySeen.set(ev.symbol, t);
    }
    for (const [sym, t] of this.anomalySeen) {
      if (now - t > ANOMALY_WINDOW_MS) this.anomalySeen.delete(sym);
    }

    const full = now - this.lastUniverseRefreshAt >= UNIVERSE_REFRESH_MS;
    if (full) this.universe.clear();

    const join = (symbol: string, tag: UniverseTag) => {
      const m = this.universe.get(symbol);
      if (m) {
        m.tags.add(tag);
        return;
      }
      if (!full && this.universe.size >= MAX_UNIVERSE) return;
      this.universe.set(symbol, { tags: new Set([tag]), joinedAt: now });
    };

    const { gainers, losers } = this.boards();
    for (const t of gainers) join(t.symbol, 'UP');
    for (const t of losers) join(t.symbol, 'DOWN');
    for (const sym of this.anomalySeen.keys()) join(sym, 'ANOM');

    if (full) this.lastUniverseRefreshAt = now;
  }

  /** 当前扫描宇宙对应的实时行情快照（内存操作，可高频调用） */
  private universeTickers(): TickerSnapshot[] {
    this.refreshUniverse(Date.now());
    const live = new Map(collector.getTickers().map((t) => [t.symbol, t as TickerSnapshot]));
    const out: TickerSnapshot[] = [];
    for (const [sym] of this.universe) {
      const t = live.get(sym);
      if (t) out.push(t); // 行情已下架 / 成交额过低的成员本轮跳过
    }
    return out;
  }

  private async scanSignals(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const symbols = this.universeTickers();
      const now = Date.now();
      const out: MaSignal[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < symbols.length) {
          const t = symbols[cursor++];
          // 信号方向随榜单来源：涨幅榜→做多、跌幅榜→做空、仅异动→双向
          // （成员暂时查不到时宽松放行，避免扫描期间宇宙重建导致整轮信号为空）
          const m = this.universe.get(t.symbol);
          const allowLong = !m || m.tags.has('UP') || m.tags.has('ANOM');
          const allowShort = !m || m.tags.has('DOWN') || m.tags.has('ANOM');
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
              if (!sig) continue;
              if (sig.type === 'LONG_MA_SUPPORT' && !allowLong) continue;
              if (sig.type === 'SHORT_MA_RESIST' && !allowShort) continue;
              out.push(sig);
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
      const symbols = this.universeTickers();
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
