// ---------- 币安行情采集器 + 异动检测引擎 ----------
// 单例（globalThis 驻留，HMR 不重复启动）：
//  - 每 5s  拉取全市场最新价  → 维护价格滚动窗口（20 分钟 5s 精度 + 更早 1 分钟精度）
//  - 每 30s 拉取全市场 24hr   → 差分出每分钟成交额，计算量比
//  - 启动后回填 Top120 币种 1m K 线，让短时涨跌即刻可用
//  - 异动检测：短时拉升/跳水、成交量激增、突破 24h 新高/新低，SQLite 持久化

import { db } from '@/lib/db';
import { bFetch, type KlineRow } from './binance';
import type {
  AnomalyEventDTO,
  AnomalyType,
  AnomalySeverity,
  MarketStats,
  TickerSnapshot,
} from './types';

// ---------- 阈值配置 ----------
const PRICE_INTERVAL_MS = 5_000;
const TF_INTERVAL_MS = 30_000;
const EVENT_COOLDOWN_MS = 5 * 60_000; // 同币种同类型异动冷却期

const MIN_QV_DISPLAY = 100_000; // 展示门槛：24h 成交额 ≥ 10 万 USDT
const MIN_QV_SPIKE = 1_000_000; // 拉升/跳水：24h 成交额门槛
const MIN_VOL1M_SPIKE = 10_000; // 拉升/跳水：1 分钟成交额门槛
const MIN_QV_BREAKOUT = 5_000_000; // 突破新高/新低门槛
const MIN_QV_SURGE = 5_000_000; // 放量门槛
const MIN_VOL1M_SURGE = 50_000;
const SURGE_MULTIPLE = 6; // 量比 ≥ 6 倍视为放量

const SPIKE_1M = 1.0; // 1 分钟涨跌幅阈值 %
const SPIKE_1M_MAJOR = 2.0;
const SPIKE_5M = 2.0; // 5 分钟涨跌幅阈值 %
const SPIKE_5M_MAJOR = 3.5;

// 排除稳定币/锚定资产计价对（对 USDT 几乎零波动，异动无意义）
const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'PYUSD', 'EUR', 'AEUR', 'EURI',
  'XUSD', 'USD1', 'USDE', 'USDS', 'SUSD', 'USTC', 'BSC-USD', 'BRL', 'TRY', 'ARS',
  'JPY', 'RUB', 'ZAR', 'MXN', 'COP', 'CZK', 'PLN', 'RON', 'HUF', 'NGN', 'UAH',
  'IDRT', 'VND', 'UAH',
]);

const TOP_BACKFILL = 120;
const BACKFILL_CONCURRENCY = 6;
const BACKFILL_CANDLES = 75;

// ---------- 内部结构 ----------
interface PricePoint {
  t: number;
  p: number;
}

interface VolSample {
  t: number; // 分钟桶
  qv: number; // 该分钟成交额（USDT）
}

interface Raw24h {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  closeTime: number;
}

interface TickerRow {
  symbol: string;
  base: string;
  price: number;
  prevPrice: number;
  open: number;
  high24h: number;
  low24h: number;
  prevHigh24h: number; // 上一轮快照的 24h 高点（用于突破检测）
  prevLow24h: number;
  change24h: number;
  quoteVolume24h: number;
  chg1m: number | null;
  chg5m: number | null;
  chg15m: number | null;
  chg1h: number | null;
  vol1m: number; // 最近一分钟成交额（0 = 未知）
  volAvg20m: number;
  tickDir: 1 | -1 | 0;
  updatedAt: number;
}

function isEligible(symbol: string): boolean {
  if (!symbol.endsWith('USDT')) return false;
  const base = symbol.slice(0, -4);
  if (!base) return false;
  if (STABLE_BASES.has(base)) return false;
  return true;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 找到时间 ≥ target 的最早采样点，计算相对当前价的涨跌 % */
function chgSince(hist: PricePoint[], target: number, price: number): number | null {
  if (!hist || hist.length === 0 || price <= 0) return null;
  for (const pt of hist) {
    if (pt.t >= target && pt.p > 0) return ((price - pt.p) / pt.p) * 100;
  }
  const lastPt = hist[hist.length - 1];
  return lastPt.p > 0 ? ((price - lastPt.p) / lastPt.p) * 100 : null;
}

function fmtSigned(v: number): string {
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

function fmtUsdt(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return Math.round(v).toLocaleString('en-US');
}

export class MarketCollector {
  private tickers = new Map<string, TickerRow>();
  private priceHist = new Map<string, PricePoint[]>();
  private volSamples = new Map<string, VolSample[]>();
  private last24hRaw = new Map<string, Raw24h>();
  private cooldowns = new Map<string, number>();
  private memoryAnomalies: AnomalyEventDTO[] = [];
  // 每日热门池：symbol -> 入选标签（VOL 成交额榜 / UP 涨幅榜 / DOWN 跌幅榜 / SURGE 放量）
  private hotPool = new Map<string, string[]>();
  private hotPoolDate = '';
  private hotPoolAt = 0;
  private hotPoolSurgeOk = false; // 上次构建时是否已包含放量数据
  private earlyFixCount = 0; // 启动后补标签重试次数（上限 10 次）
  private started = false;
  private starting: Promise<void> | null = null;
  private backfillDone = false;
  private priceTimer: ReturnType<typeof setInterval> | null = null;
  private tfTimer: ReturnType<typeof setInterval> | null = null;
  meta = {
    startedAt: 0,
    lastPriceOk: 0,
    last24hOk: 0,
    priceErr: 0,
    tfErr: 0,
    lastError: '',
  };

  /** 启动采集（幂等）。返回一个最多等待 6s 的就绪 Promise，超时不阻塞响应。 */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, sleep(6000)]);
      return;
    }
    this.started = true;
    this.meta.startedAt = Date.now();
    this.starting = (async () => {
      await this.refresh24h().catch(() => {});
      void this.backfillTop();
      void this.refreshPrices();
      this.priceTimer = setInterval(() => void this.refreshPrices(), PRICE_INTERVAL_MS);
      this.tfTimer = setInterval(() => void this.refresh24h(), TF_INTERVAL_MS);
    })();
    await Promise.race([this.starting, sleep(6000)]);
  }

  getTickers(): TickerSnapshot[] {
    const out: TickerSnapshot[] = [];
    for (const row of this.tickers.values()) {
      if (row.quoteVolume24h < MIN_QV_DISPLAY) continue;
      out.push({
        symbol: row.symbol,
        base: row.base,
        price: row.price,
        open: row.open,
        high24h: row.high24h,
        low24h: row.low24h,
        change24h: row.change24h,
        quoteVolume24h: row.quoteVolume24h,
        chg1m: row.chg1m,
        chg5m: row.chg5m,
        chg15m: row.chg15m,
        chg1h: row.chg1h,
        vol1m: row.vol1m > 0 ? row.vol1m : null,
        volMultiple: row.volAvg20m > 0 && row.vol1m > 0 ? row.vol1m / row.volAvg20m : null,
        tickDir: row.tickDir,
        hotTags: this.hotPool.get(row.symbol) ?? null,
        updatedAt: row.updatedAt,
      });
    }
    return out;
  }

  hasSymbol(symbol: string): boolean {
    return this.tickers.has(symbol);
  }

  getStats(): MarketStats {
    const now = Date.now();
    let totalQV = 0;
    let adv = 0;
    let dec = 0;
    let flat = 0;
    let tracked = 0;
    let btc: MarketStats['btc'] = null;
    let eth: MarketStats['eth'] = null;
    for (const row of this.tickers.values()) {
      if (row.quoteVolume24h < MIN_QV_DISPLAY) continue;
      tracked++;
      totalQV += row.quoteVolume24h;
      if (row.change24h > 0.01) adv++;
      else if (row.change24h < -0.01) dec++;
      else flat++;
      if (row.symbol === 'BTCUSDT') btc = { price: row.price, change24h: row.change24h };
      if (row.symbol === 'ETHUSDT') eth = { price: row.price, change24h: row.change24h };
    }
    return {
      ts: now,
      startedAt: this.meta.startedAt,
      symbolsTracked: tracked,
      totalQuoteVolume: totalQV,
      advancing: adv,
      declining: dec,
      flat,
      btc,
      eth,
      lastPriceOk: this.meta.lastPriceOk,
      last24hOk: this.meta.last24hOk,
      sourceOk: now - this.meta.lastPriceOk < 20_000,
      backfilled: this.backfillDone,
    };
  }

  getMemoryAnomalies(): AnomalyEventDTO[] {
    return this.memoryAnomalies;
  }

  // ================= 内部实现 =================

  private async refreshPrices(): Promise<void> {
    try {
      const arr = await bFetch<{ symbol: string; price: string }[]>('/api/v3/ticker/price');
      const now = Date.now();
      for (const item of arr) {
        const { symbol } = item;
        if (!isEligible(symbol)) continue;
        const p = Number(item.price);
        if (!Number.isFinite(p) || p <= 0) continue;

        // 价格滚动窗口
        let hist = this.priceHist.get(symbol);
        if (!hist) {
          hist = [];
          this.priceHist.set(symbol, hist);
        }
        hist.push({ t: now, p });
        this.trimHist(hist, now);

        const row = this.tickers.get(symbol);
        if (!row) {
          // 24h 数据尚未到达时先建骨架
          this.tickers.set(symbol, {
            symbol,
            base: symbol.slice(0, -4),
            price: p,
            prevPrice: p,
            open: p,
            high24h: p,
            low24h: p,
            prevHigh24h: p,
            prevLow24h: p,
            change24h: 0,
            quoteVolume24h: 0,
            chg1m: null,
            chg5m: null,
            chg15m: null,
            chg1h: null,
            vol1m: 0,
            volAvg20m: 0,
            tickDir: 0,
            updatedAt: now,
          });
          continue;
        }
        row.prevPrice = row.price;
        if (p > row.price) row.tickDir = 1;
        else if (p < row.price) row.tickDir = -1;
        row.price = p;
        row.updatedAt = now;
        // 短时涨跌缓存（每 5s 一次，避免请求时重复计算）
        row.chg1m = chgSince(hist, now - 60_000, p);
        row.chg5m = chgSince(hist, now - 5 * 60_000, p);
        row.chg15m = chgSince(hist, now - 15 * 60_000, p);
        row.chg1h = chgSince(hist, now - 60 * 60_000, p);
        this.detectPriceAnomalies(row, now);
      }
      this.meta.lastPriceOk = now;
      this.meta.priceErr = 0;
    } catch (e) {
      this.meta.priceErr++;
      this.meta.lastError = errMsg(e);
    }
  }

  /** 压缩历史：20 分钟内保留 5s 精度，更早的压缩为 1 分钟精度，总量 ≤ 75 分钟 */
  private trimHist(hist: PricePoint[], now: number) {
    const maxAge = now - 75 * 60_000;
    // 丢弃超老数据
    let drop = 0;
    while (drop < hist.length && hist[drop].t < maxAge) drop++;
    if (drop > 0) hist.splice(0, drop);
    // 20 分钟以前：每分钟仅保留一个点
    const cutoff = now - 20 * 60_000;
    let bound = 0;
    while (bound < hist.length && hist[bound].t < cutoff) bound++;
    if (bound <= 1) return;
    const compacted: PricePoint[] = [];
    let lastMinute = -1;
    for (let i = 0; i < bound; i++) {
      const m = Math.floor(hist[i].t / 60_000);
      if (m !== lastMinute) {
        compacted.push(hist[i]);
        lastMinute = m;
      }
    }
    if (compacted.length < bound) {
      hist.splice(0, bound, ...compacted);
    }
  }

  private async refresh24h(): Promise<void> {
    try {
      const arr = await bFetch<Raw24h[]>('/api/v3/ticker/24hr');
      const now = Date.now();
      for (const raw of arr) {
        if (!isEligible(raw.symbol)) continue;
        const qv = Number(raw.quoteVolume);
        if (!Number.isFinite(qv)) continue;
        const high = Number(raw.highPrice);
        const low = Number(raw.lowPrice);
        const open = Number(raw.openPrice);
        const last = Number(raw.lastPrice);

        // 差分出每分钟成交额
        const prevRaw = this.last24hRaw.get(raw.symbol);
        if (prevRaw) {
          const dtMin = (raw.closeTime - prevRaw.closeTime) / 60_000;
          if (dtMin >= 0.7 && dtMin <= 6) {
            const perMin = (qv - Number(prevRaw.quoteVolume)) / dtMin;
            if (Number.isFinite(perMin) && perMin >= 0) {
              const bucket = Math.floor(now / 60_000) * 60_000;
              let vs = this.volSamples.get(raw.symbol);
              if (!vs) {
                vs = [];
                this.volSamples.set(raw.symbol, vs);
              }
              const lastS = vs[vs.length - 1];
              if (lastS && lastS.t === bucket) lastS.qv = perMin;
              else {
                vs.push({ t: bucket, qv: perMin });
                if (vs.length > 30) vs.splice(0, vs.length - 30);
              }
            }
          }
        }
        this.last24hRaw.set(raw.symbol, raw);

        let row = this.tickers.get(raw.symbol);
        if (!row) {
          row = {
            symbol: raw.symbol,
            base: raw.symbol.slice(0, -4),
            price: last,
            prevPrice: last,
            open,
            high24h: high,
            low24h: low,
            prevHigh24h: high,
            prevLow24h: low,
            change24h: Number(raw.priceChangePercent),
            quoteVolume24h: qv,
            chg1m: null,
            chg5m: null,
            chg15m: null,
            chg1h: null,
            vol1m: 0,
            volAvg20m: 0,
            tickDir: 0,
            updatedAt: now,
          };
          this.tickers.set(raw.symbol, row);
        } else {
          row.prevHigh24h = row.high24h;
          row.prevLow24h = row.low24h;
          row.open = open;
          row.high24h = high;
          row.low24h = low;
          row.change24h = Number(raw.priceChangePercent);
          row.quoteVolume24h = qv;
          if (row.price <= 0) row.price = last;
        }

        // 量比统计
        const vs = this.volSamples.get(raw.symbol);
        if (vs && vs.length >= 5) {
          const window = vs.slice(-21, -1); // 过去 20 个完整分钟
          const avg = window.reduce((s, x) => s + x.qv, 0) / window.length;
          row.volAvg20m = avg;
          row.vol1m = vs[vs.length - 1].qv;
        }
      }
      this.meta.last24hOk = now;
      this.meta.tfErr = 0;
      this.detectVolumeSurges(now);
      this.ensureHotPool(now);
    } catch (e) {
      this.meta.tfErr++;
      this.meta.lastError = errMsg(e);
    }
  }

  // ---------- 每日热门池 ----------

  /** UTC+8 日期字符串 */
  private cnDate(now: number): string {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  }

  /**
   * 热门池选取（每日 00:00 UTC+8 重建，当日成员固定）：
   *  - 24h 成交额 Top80（VOL）
   *  - 24h 涨幅榜 Top40（UP，仅上涨币）
   *  - 24h 跌幅榜 Top40（DOWN，仅下跌币）
   *  - 实时放量 Top20（SURGE，量比 ≥ 4）
   * 同一币种可多标签入选，去重后即“今日热门”，保障暴涨暴跌的小币种不被成交额门槛埋没。
   */
  private ensureHotPool(now: number) {
    const date = this.cnDate(now);
    const isNewDay = date !== this.hotPoolDate;
    if (isNewDay) this.earlyFixCount = 0;
    const isEmpty = this.hotPool.size === 0;
    const refreshDue = now - this.hotPoolAt >= 30 * 60_000; // 当日内每 30 分钟随 24h 滚动窗口轻度刷新
    const earlyFix =
      this.earlyFixCount < 10 &&
      !this.hotPoolSurgeOk &&
      this.hotPoolAt > 0 &&
      now - this.meta.startedAt >= 2 * 60_000 &&
      now - this.hotPoolAt >= 60_000; // 服务重启后量能就绪，补上放量标签（每分钟重试，最多 10 次）
    if (!isNewDay && !isEmpty && !refreshDue && !earlyFix) return;

    const rows = [...this.tickers.values()].filter((r) => r.quoteVolume24h >= 1_000_000);
    if (rows.length < 50) return; // 行情尚未就绪

    const byVol = [...rows].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h).slice(0, 80);
    const byUp = [...rows]
      .filter((r) => r.change24h > 0)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 40);
    const byDown = [...rows]
      .filter((r) => r.change24h < 0)
      .sort((a, b) => a.change24h - b.change24h)
      .slice(0, 40);
    const bySurge = [...rows]
      .filter((r) => r.volAvg20m > 0 && r.vol1m > 0 && r.vol1m / r.volAvg20m >= 4)
      .sort((a, b) => b.vol1m / b.volAvg20m - a.vol1m / a.volAvg20m)
      .slice(0, 20);

    const pool = new Map<string, string[]>();
    const add = (list: typeof rows, tag: string) => {
      for (const r of list) {
        const tags = pool.get(r.symbol) ?? [];
        if (!tags.includes(tag)) tags.push(tag);
        pool.set(r.symbol, tags);
      }
    };
    add(byVol, 'VOL');
    add(byUp, 'UP');
    add(byDown, 'DOWN');
    add(bySurge, 'SURGE');

    this.hotPool = pool;
    this.hotPoolDate = date;
    this.hotPoolAt = now;
    this.hotPoolSurgeOk = bySurge.length > 0;
    if (this.hotPoolSurgeOk) this.earlyFixCount = 10;
    else this.earlyFixCount++;

    // 持久化当日名单（best-effort）
    const entries = [...pool.entries()];
    void (async () => {
      try {
        await db.hotPoolEntry.deleteMany({ where: { date } });
        if (entries.length > 0) {
          await db.hotPoolEntry.createMany({
            data: entries.map(([symbol, tags], i) => ({
              date,
              symbol,
              base: symbol.slice(0, -4),
              tags: JSON.stringify(tags),
              rank: i,
            })),
          });
        }
      } catch {
        // 持久化失败不影响内存热榜
      }
    })();
  }

  getHotPool(): {
    date: string;
    total: number;
    tags: Record<string, number>;
    symbols: string[];
    updatedAt: number;
  } {
    const tags: Record<string, number> = { VOL: 0, UP: 0, DOWN: 0, SURGE: 0 };
    for (const arr of this.hotPool.values()) {
      for (const t of arr) tags[t] = (tags[t] ?? 0) + 1;
    }
    return {
      date: this.hotPoolDate,
      total: this.hotPool.size,
      tags,
      symbols: [...this.hotPool.keys()],
      updatedAt: this.hotPoolAt,
    };
  }

  // ---------- 异动检测 ----------

  private detectPriceAnomalies(row: TickerRow, now: number) {
    const liquidEnough = row.quoteVolume24h >= MIN_QV_SPIKE && row.vol1m >= MIN_VOL1M_SPIKE;
    if (liquidEnough) {
      const c1 = row.chg1m;
      const c5 = row.chg5m;
      if (c1 != null && Math.abs(c1) >= SPIKE_1M) {
        const sev: AnomalySeverity = Math.abs(c1) >= SPIKE_1M_MAJOR ? 'MAJOR' : 'MINOR';
        void this.emit(
          row,
          c1 >= 0 ? 'SPIKE_UP' : 'SPIKE_DOWN',
          sev,
          c1,
          now,
          `1 分钟内${c1 >= 0 ? '快速拉升' : '急速下挫'} ${fmtSigned(c1)}，1 分钟成交额 ${fmtUsdt(row.vol1m)} USDT`,
        );
      } else if (c5 != null && Math.abs(c5) >= SPIKE_5M) {
        const sev: AnomalySeverity = Math.abs(c5) >= SPIKE_5M_MAJOR ? 'MAJOR' : 'MINOR';
        void this.emit(
          row,
          c5 >= 0 ? 'SPIKE_UP' : 'SPIKE_DOWN',
          sev,
          c5,
          now,
          `5 分钟内${c5 >= 0 ? '持续拉升' : '持续下挫'} ${fmtSigned(c5)}`,
        );
      }
    }

    // 突破 24h 新高 / 新低（与上一轮快照比较）
    if (row.quoteVolume24h >= MIN_QV_BREAKOUT) {
      if (row.prevHigh24h > 0 && row.price > row.prevHigh24h) {
        const pct = ((row.price - row.prevHigh24h) / row.prevHigh24h) * 100;
        void this.emit(
          row,
          'BREAKOUT_HIGH',
          'MAJOR',
          pct,
          now,
          `突破 24 小时新高，超越前高 ${fmtSigned(pct)}`,
        );
      } else if (row.prevLow24h > 0 && row.price < row.prevLow24h) {
        const pct = ((row.price - row.prevLow24h) / row.prevLow24h) * 100;
        void this.emit(
          row,
          'BREAKOUT_LOW',
          'MAJOR',
          pct,
          now,
          `跌破 24 小时新低，低于前低 ${fmtSigned(pct)}`,
        );
      }
    }
  }

  private detectVolumeSurges(now: number) {
    for (const row of this.tickers.values()) {
      if (row.quoteVolume24h < MIN_QV_SURGE) continue;
      if (row.vol1m < MIN_VOL1M_SURGE || row.volAvg20m <= 0) continue;
      const mult = row.vol1m / row.volAvg20m;
      if (mult >= SURGE_MULTIPLE) {
        const sev: AnomalySeverity = mult >= 12 || row.vol1m >= 2_000_000 ? 'MAJOR' : 'MINOR';
        const dir = (row.chg5m ?? 0) >= 0 ? '放量上攻' : '放量下杀';
        void this.emit(
          row,
          'VOLUME_SURGE',
          sev,
          row.chg5m ?? 0,
          now,
          `1 分钟成交额 ${fmtUsdt(row.vol1m)} USDT，达过去 20 分钟均值的 ${mult.toFixed(1)} 倍，${dir}`,
          mult,
          row.vol1m,
        );
      }
    }
  }

  private async emit(
    row: TickerRow,
    type: AnomalyType,
    severity: AnomalySeverity,
    changePct: number,
    now: number,
    detail: string,
    volumeMultiple = 0,
    quoteVolume1m = 0,
  ): Promise<void> {
    // 冷却去重（同步执行，避免并发重复）
    const key = `${row.symbol}:${type}`;
    const lastAt = this.cooldowns.get(key);
    if (lastAt && now - lastAt < EVENT_COOLDOWN_MS) return;
    this.cooldowns.set(key, now);
    if (this.cooldowns.size > 6000) {
      for (const [k, t] of this.cooldowns) {
        if (now - t > 30 * 60_000) this.cooldowns.delete(k);
      }
    }

    const dto: AnomalyEventDTO = {
      id: `${now}-${row.symbol}-${type}`,
      symbol: row.symbol,
      base: row.base,
      type,
      severity,
      price: row.price,
      changePct,
      volumeMultiple,
      quoteVolume1m: quoteVolume1m || row.vol1m,
      detail,
      createdAt: new Date(now).toISOString(),
    };
    this.memoryAnomalies.unshift(dto);
    if (this.memoryAnomalies.length > 300) this.memoryAnomalies.pop();

    try {
      await db.anomalyEvent.create({
        data: {
          symbol: dto.symbol,
          base: dto.base,
          type,
          severity,
          price: dto.price,
          changePct,
          volumeMultiple,
          quoteVolume1m: dto.quoteVolume1m,
          detail,
          createdAt: new Date(now),
        },
      });
    } catch {
      // DB 失败不阻断采集（内存副本仍可读）
    }
  }

  // ---------- 启动回填：拉取 Top120 的 1m K 线，让短时涨跌/量比立即可用 ----------

  private async backfillTop(): Promise<void> {
    try {
      for (let i = 0; i < 20 && this.meta.last24hOk === 0; i++) await sleep(500);
      if (this.meta.last24hOk === 0) return;
      const top = [...this.tickers.values()]
        .filter((r) => r.quoteVolume24h >= MIN_QV_SPIKE)
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
        .slice(0, TOP_BACKFILL);
      const now = Date.now();
      let cursor = 0;
      const worker = async () => {
        while (cursor < top.length) {
          const row = top[cursor++];
          try {
            const kl = await bFetch<KlineRow[]>('/api/v3/klines', {
              symbol: row.symbol,
              interval: '1m',
              limit: BACKFILL_CANDLES,
            });
            const hist: PricePoint[] = [];
            const vs: VolSample[] = [];
            for (const k of kl) {
              const t = Number(k[0]);
              const close = Number(k[4]);
              const qv = Number(k[7]);
              if (!Number.isFinite(close)) continue;
              hist.push({ t, p: close });
              if (t >= now - 21 * 60_000 && Number.isFinite(qv)) vs.push({ t, qv });
            }
            if (hist.length > 0) {
              hist.push({ t: now, p: row.price });
              this.priceHist.set(row.symbol, hist);
            }
            // 最后一根 1m K 线未走完，剔除后作为量能基线
            const closed = vs.slice(0, -1);
            if (closed.length >= 4) {
              const window = closed.slice(-20);
              const avg = window.reduce((s, x) => s + x.qv, 0) / window.length;
              if (row.volAvg20m <= 0) row.volAvg20m = avg;
              if (row.vol1m <= 0) row.vol1m = closed[closed.length - 1].qv;
              this.volSamples.set(row.symbol, closed);
            }
            row.chg1m = chgSince(hist, now - 60_000, row.price);
            row.chg5m = chgSince(hist, now - 5 * 60_000, row.price);
            row.chg15m = chgSince(hist, now - 15 * 60_000, row.price);
            row.chg1h = chgSince(hist, now - 60 * 60_000, row.price);
          } catch {
            // 单币种失败忽略
          }
        }
      };
      await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, worker));
      this.backfillDone = true;
    } catch {
      // 回填失败不影响后续实时采集
    }
  }
}

// ---------- 全局单例（HMR 安全） ----------
const g = globalThis as typeof globalThis & {
  __binanceRadarCollector?: MarketCollector;
};

export const collector: MarketCollector = (g.__binanceRadarCollector ??= new MarketCollector());
