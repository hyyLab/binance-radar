// ---------- USDT-M 合约多源行情采集器（升级版异动交易数据源） ----------
// 架构（Task 50 用户定版）：多源发现异动 + 单源供价。
//  - 品种白名单 = 币安 U 本位永续（binance instruments：PERPETUAL+USDT+TRADING），
//    只做币安包含的品种；Bybit / Gate 仅作为同一批符号的行情冗余源；
//  - 供价优先级 币安 > Bybit > Gate：同一符号的短窗涨跌幅/量能只从「其所属源」的
//    自身价格史计算（绝不混源——拼源会造出假异动）；源连续失败自动挂起 60s 并降级
//    下一源，恢复后按优先级自动回到币安；
//  - 每 5s 全源拉最新价 → 维护各源价格滚动窗口（20 分钟 5s 精度 + 更早 1 分钟精度）；
//    每 30s 拉 24hr 统计 → 差分出每分钟成交额；启动回填 Top120 的 1m K 线，
//    让 chg1m/chg5m 即刻可用（与现货 collector 同款工艺）。
// ⚠️ Turbopack dev 下每个 API 路由可持有独立模块图：模块级单例必须「同 key 必复用」
//    （跨路由收敛到同一实例），代码更新靠 bump key（v1→v2…）；跨引擎引用一律走
//    稳定别名 __binanceRadarFuturesActive 动态解析活跃实例（Task 44 规则）。

import { isExcludedBase } from './excluded';
import {
  FUTURES_SOURCE_PRIORITY,
  SOURCE_LABEL,
  fetch24h,
  fetchInstruments,
  fetchKlines,
  fetchPrices,
  FuturesFetchError,
  type FuturesCandle,
  type FuturesSourceName,
  type InstrumentsMap,
  type KlinesOpts,
  type Stats24Row,
} from './futures-feeds';
import type { FuturesSourceHealth, TickerSnapshot } from './types';

// ---------- 常量 ----------
const PRICE_INTERVAL_MS = 5_000;
const INSTRUMENT_REFRESH_MS = 60 * 60_000; // 合约清单每小时刷新
const MIN_QV_DISPLAY = 100_000; // 展示门槛：24h 成交额 ≥ 10 万 USDT
const TOP_BACKFILL = 120;
const SUSPEND_MS = 60_000; // 源连续失败挂起时长
// 418/429 限频：仅在拿不到服务方 retry-after 时用的兕底挂起。Task 60 根治封禁升级：
// 封禁时长以币安 retry-after/banned until 为准（挂满整个封禁期），实测被短挂起反复
// 撞墙升级到 24h 的教训——挂起期内任何模块（含 instruments 刷新）不得出站该源
const RATE_LIMIT_SUSPEND_MS = 180_000;
const RATE_LIMIT_BAN_CAP_MS = 72 * 3600_000; // 封禁挂起安全上限（币安最严禁令 3 天）
const FAIL_STREAK_LIMIT = 4; // 连续失败次数阈值（≈20s 全失败即挂起）
const PRICE_FRESH_MS = 15_000; // 供价源数据新鲜度要求

// ============ 分片配额（Task 51 用户定版） ============
// 品种白名单 = 币安 U 本位永续；币安只供价 Top125（模拟盘规则本体 + 最高频交易标的），
// 其余 ~400 个由 Bybit/Gate 平分（行情大差不差、异动方向一致，价格精度不重要）。
// 币安 fapi 对本 IP 实测极易触发 418，分片 + 令牌桶把币安出站压到安全水位。
const BINANCE_SHARD_SIZE = 125;
const OTHER_SHARD_QUOTA = 200;

/** 24hr 统计轮询间隔：币安 60s（压权重，vol 差分 dt≈1min 仍在有效窗口），Bybit/Gate 30s */
const STATS_INTERVAL_MS: Record<FuturesSourceName, number> = {
  binance: 60_000,
  bybit: 30_000,
  gate: 30_000,
};
const STATS_RETRY_MS = 15_000; // 统计轮询失败快速重试

// ---------- 内部结构 ----------
interface PricePoint {
  t: number;
  p: number;
}

interface VolSample {
  t: number; // 分钟桶
  qv: number; // 每分钟成交额（USDT，差分归一化）
}

interface SourceState {
  instruments: InstrumentsMap;
  instrumentsAt: number;
  lastPriceAt: number;
  last24hAt: number;
  nextStatsAt: number; // 下次 24hr 轮询到期时间（每源差异化间隔）
  failStreak: number;
  suspendUntil: number;
  /** Task 60：418/429 封禁硬截止（epoch ms；0 = 无）。挂起期内偶发成功不提前解锁，
   *  杜绝「解锁→突发→再 418→累犯升级」循环 */
  bannedUntil: number;
  lastError: string;
  klineReqs: number; // 该源实际承接的 K 线请求数（分片分配观测）
  priceHist: Map<string, PricePoint[]>;
  stats24: Map<string, Stats24Row>;
  lastVolSnap: Map<string, { at: number; qv24: number }>;
  volSamples: Map<string, VolSample[]>;
}

/** 聚合后的行情行（= TickerSnapshot + 来源标记） */
type MergedRow = TickerSnapshot & { source: FuturesSourceName };

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

export class FuturesCollector {
  private sources: Record<FuturesSourceName, SourceState>;
  private merged = new Map<string, MergedRow>();
  /** 每符号的「归属源」分片（Task 51）：币安 Top125，其余 Bybit/Gate 平分；
   *  供价与 K 线主源都跟归属走，源挂掉时临时降级到其它源 */
  private shards = new Map<string, FuturesSourceName>();
  private shardsAt = 0;
  private started = false;
  private starting: Promise<void> | null = null;
  priceTimer: ReturnType<typeof setInterval> | null = null;
  tfTimer: ReturnType<typeof setInterval> | null = null;
  meta = { startedAt: 0 };

  /** 旧实例状态交接（bump key 时）：继承三源清单/价格史/统计/量能基线，
   *  避免币安封禁期重建后白名单丢失导致行情全停，也避免重复回填 */
  constructor(carry?: FuturesCollector) {
    this.sources = {
      binance: FuturesCollector.freshSource(),
      bybit: FuturesCollector.freshSource(),
      gate: FuturesCollector.freshSource(),
    };
    if (carry) {
      for (const s of FUTURES_SOURCE_PRIORITY) {
        const old = carry.sources[s];
        const fresh = this.sources[s];
        fresh.instruments = old.instruments;
        fresh.instrumentsAt = old.instrumentsAt;
        fresh.lastPriceAt = old.lastPriceAt;
        fresh.last24hAt = old.last24hAt;
        fresh.priceHist = old.priceHist;
        fresh.stats24 = old.stats24;
        fresh.lastVolSnap = old.lastVolSnap;
        fresh.volSamples = old.volSamples;
        // Task 60：封禁状态跨 bump 交接——重建实例不探针（避免封禁期撞墙刷新累犯计数）
        fresh.suspendUntil = old.suspendUntil ?? 0;
        fresh.bannedUntil = old.bannedUntil ?? 0;
        fresh.lastError = old.lastError ?? '';
      }
      this.shards = carry.shards ?? new Map<string, FuturesSourceName>(); // v1 遗留实例无分片字段
      this.shardsAt = carry.shardsAt ?? 0;
    }
  }

  private static freshSource(): SourceState {
    return {
      instruments: new Map(),
      instrumentsAt: 0,
      lastPriceAt: 0,
      last24hAt: 0,
      nextStatsAt: 0,
      failStreak: 0,
      suspendUntil: 0,
      bannedUntil: 0,
      lastError: '',
      klineReqs: 0,
      priceHist: new Map(),
      stats24: new Map(),
      lastVolSnap: new Map(),
      volSamples: new Map(),
    };
  }

  /** 启动采集（幂等）。返回最多等待 6s 的就绪 Promise，超时不阻塞响应。 */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, sleep(6000)]);
      return;
    }
    this.started = true;
    this.meta.startedAt = Date.now();
    this.starting = this.boot();
    await Promise.race([this.starting, sleep(6000)]);
  }

  private async boot(): Promise<void> {
    // 1) 首拉合约清单（继承自旧实例的清单立即可用；缺失的源正常拉取）
    await Promise.allSettled(FUTURES_SOURCE_PRIORITY.map((s) => this.refreshInstruments(s)));
    // 2) 首拉价格 + 24h（继承数据已就绪时本轮只做增量刷新）
    await Promise.allSettled([this.pollAllPrices(), this.pollAllStats()]);
    // 3) 定时器：5s 价格 / 10s 统计到期检查（币安 24hr 实际 60s，Bybit/Gate 30s）
    this.priceTimer = setInterval(() => void this.pollAllPrices(), PRICE_INTERVAL_MS);
    this.tfTimer = setInterval(() => void this.pollAllStats(), 10_000);
    // 4) 启动回填 Top（chg1m/chg5m 即刻可用；已有充足价格史的标的自动跳过）
    void this.backfillTop();
  }

  // ============ 合约清单（每小时自刷新，失败 60s 重试） ============

  private async refreshInstruments(source: FuturesSourceName): Promise<void> {
    const st = this.sources[source];
    // Task 60：挂起期间不出站（418 封禁期内打 instruments 同样刷新累犯计数、延长封禁）
    const now = Date.now();
    if (now < st.suspendUntil) {
      setTimeout(() => void this.refreshInstruments(source), st.suspendUntil - now + 5_000);
      return;
    }
    try {
      st.instruments = await fetchInstruments(source);
      st.instrumentsAt = Date.now();
      st.failStreak = 0;
      if (Date.now() >= st.bannedUntil) {
        st.suspendUntil = 0;
        st.bannedUntil = 0;
        st.lastError = '';
      }
      setTimeout(() => void this.refreshInstruments(source), INSTRUMENT_REFRESH_MS);
    } catch (e) {
      // 418/429 同样按 retry-after 长挂起（instruments 撞墙也是撞墙）
      this.applyRateLimitSuspend(source, e);
      st.lastError = errMsg(e);
      const wait = Math.max(60_000, st.suspendUntil - Date.now() + 5_000);
      setTimeout(() => void this.refreshInstruments(source), wait);
    }
  }

  // ============ 价格轮询（每 5s 全源并行） ============

  private async pollAllPrices(): Promise<void> {
    const now = Date.now();
    await Promise.allSettled(
      FUTURES_SOURCE_PRIORITY.map(async (s) => {
        const st = this.sources[s];
        if (now < st.suspendUntil || st.instruments.size === 0) return;
        try {
          const rows = await fetchPrices(s, st.instruments);
          this.ingestPrices(s, rows);
          st.failStreak = 0;
          // Task 60：封禁期内偶发成功（边缘节点执行不一致）不提前解锁，挂满到 bannedUntil
          if (Date.now() >= st.bannedUntil) {
            st.suspendUntil = 0;
            st.bannedUntil = 0;
            st.lastError = '';
          }
        } catch (e) {
          this.noteFailure(s, e);
        }
      }),
    );
    this.rebuildMerged();
  }

  private ingestPrices(source: FuturesSourceName, rows: { symbol: string; price: number }[]) {
    const st = this.sources[source];
    const now = Date.now();
    for (const r of rows) {
      let hist = st.priceHist.get(r.symbol);
      if (!hist) {
        hist = [];
        st.priceHist.set(r.symbol, hist);
      }
      hist.push({ t: now, p: r.price });
      this.trimHist(hist, now);
    }
    st.lastPriceAt = now;
  }

  /** 压缩历史：20 分钟内保留 5s 精度，更早的压缩为 1 分钟精度，总量 ≤ 75 分钟 */
  private trimHist(hist: PricePoint[], now: number) {
    const maxAge = now - 75 * 60_000;
    let drop = 0;
    while (drop < hist.length && hist[drop].t < maxAge) drop++;
    if (drop > 0) hist.splice(0, drop);
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

  // ============ 24hr 统计（每 30s 全源并行，差分 vol1m） ============

  private async pollAllStats(): Promise<void> {
    const now = Date.now();
    await Promise.allSettled(
      FUTURES_SOURCE_PRIORITY.map(async (s) => {
        const st = this.sources[s];
        if (now < st.suspendUntil || st.instruments.size === 0) return;
        if (now < st.nextStatsAt) return; // 每源差异化间隔（币安 60s，其余 30s）
        st.nextStatsAt = now + STATS_INTERVAL_MS[s];
        try {
          const rows = await fetch24h(s, st.instruments);
          this.ingestStats(s, rows, Date.now());
          st.failStreak = 0;
          // Task 60：封禁期内偶发成功不提前解锁（同价格轮询口径）
          if (Date.now() >= st.bannedUntil) {
            st.suspendUntil = 0;
            st.bannedUntil = 0;
            st.lastError = '';
          }
        } catch (e) {
          st.nextStatsAt = now + STATS_RETRY_MS; // 失败快速重试
          this.noteFailure(s, e);
        }
      }),
    );
    this.rebuildMerged();
  }

  private ingestStats(source: FuturesSourceName, rows: Stats24Row[], now: number) {
    const st = this.sources[source];
    for (const row of rows) {
      // 差分出每分钟成交额（窗口下限仅防零间隔抖动，同现货 collector 参数）
      const prev = st.lastVolSnap.get(row.symbol);
      if (prev) {
        const dtMin = (now - prev.at) / 60_000;
        if (dtMin >= 0.35 && dtMin <= 6) {
          const perMin = (row.qv24 - prev.qv24) / dtMin;
          if (Number.isFinite(perMin) && perMin >= 0) {
            const bucket = Math.floor(now / 60_000) * 60_000;
            let vs = st.volSamples.get(row.symbol);
            if (!vs) {
              vs = [];
              st.volSamples.set(row.symbol, vs);
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
      st.lastVolSnap.set(row.symbol, { at: now, qv24: row.qv24 });
      st.stats24.set(row.symbol, row);
    }
    st.last24hAt = now;
  }

  /** Task 60：418/429 封禁挂起（挂满服务方告知的整个封禁期）。
   *  命中返回 true（调用方跳过常规失败计数）；未命中返回 false。
   *  ⚠️ 本方法与「成功路径清挂起」的协作语义：封禁期内偶发成功（币安边缘节点
   *  封禁执行不一致）不得解锁——见各成功路径的 bannedUntil 检查。 */
  private applyRateLimitSuspend(source: FuturesSourceName, e: unknown): boolean {
    const msg = errMsg(e);
    if (!msg.includes('HTTP 418') && !msg.includes('HTTP 429')) return false;
    const st = this.sources[source];
    const ra = e instanceof FuturesFetchError ? e.retryAfterMs : 0;
    const until =
      Date.now() +
      Math.min(Math.max(ra, RATE_LIMIT_SUSPEND_MS) + 60_000, RATE_LIMIT_BAN_CAP_MS);
    st.suspendUntil = Math.max(st.suspendUntil, until);
    st.bannedUntil = Math.max(st.bannedUntil, until);
    st.failStreak = 0;
    st.lastError = msg;
    return true;
  }

  private noteFailure(source: FuturesSourceName, e: unknown) {
    const st = this.sources[source];
    const msg = errMsg(e);
    st.lastError = msg;
    // 418/429 = 限频/IP 封禁：按服务方 retry-after 挂满封禁期（封禁期内零出站，
    // 避免反复撞墙刷新币安累犯计数、把封禁时长越顶越高）
    if (this.applyRateLimitSuspend(source, e)) return;
    st.failStreak++;
    if (st.failStreak >= FAIL_STREAK_LIMIT) {
      st.suspendUntil = Date.now() + SUSPEND_MS;
      st.failStreak = 0;
    }
  }

  // ============ 分片：按成交额把品种分配给三源（boot 后首次统计就绪时分配一次） ============

  /** 排序权重：优先币安自身 24h 成交额（供价基准一致），不可用时退其它源（口径差异不影响排序大局） */
  private rankKey(symbol: string): number {
    for (const s of FUTURES_SOURCE_PRIORITY) {
      const st = this.sources[s].stats24.get(symbol);
      if (st && st.qv24 > 0) return st.qv24;
    }
    return 0;
  }

  private assignShards(): void {
    if (this.shards.size > 0) return; // 运行期不重排：避免 K 线序列跨源拼接
    // 等统计就绪（任意源有 24h 成交额即可排序；币安被封时 Bybit/Gate 统计照常流入）
    const hasStats = FUTURES_SOURCE_PRIORITY.some(
      (s) => this.sources[s].stats24.size > 0,
    );
    if (!hasStats || this.sources.binance.instruments.size === 0) return;

    const whitelist = this.sources.binance.instruments;
    const sorted = [...whitelist.keys()]
      .filter((sym) => !isExcludedBase(whitelist.get(sym)!.base))
      .sort((a, b) => this.rankKey(b) - this.rankKey(a));

    let otherToggle = 0; // bybit/gate 交替发牌 → 两所成交额质量大体对半
    const quota: Record<FuturesSourceName, number> = {
      binance: BINANCE_SHARD_SIZE,
      bybit: OTHER_SHARD_QUOTA,
      gate: OTHER_SHARD_QUOTA,
    };
    for (const sym of sorted) {
      // 币安配额内（Top125）：按优先级+配额选归属
      let home: FuturesSourceName | null = null;
      for (const s of FUTURES_SOURCE_PRIORITY) {
        if (quota[s] <= 0 || !this.sources[s].instruments.has(sym)) continue;
        home = s;
        quota[s]--;
        break;
      }
      // 配额用尽 → 双所覆盖则交替发牌；单所覆盖归该所；两所都不覆盖（新上币等）回币安
      if (!home) {
        const covered = FUTURES_SOURCE_PRIORITY.filter(
          (s) => s !== 'binance' && this.sources[s].instruments.has(sym),
        );
        if (covered.length === 2) {
          home = covered[otherToggle % 2];
          otherToggle++;
        } else if (covered.length === 1) {
          home = covered[0];
        } else {
          home = 'binance'; // 极少数（如刚上线币安的新品种）：币安兜底，K 线成本可忽略
        }
      }
      this.shards.set(sym, home);
    }
    this.shardsAt = Date.now();
  }

  /** 归属源（未分片时按优先级首个覆盖源兑底） */
  private homeOf(symbol: string): FuturesSourceName {
    const home = this.shards.get(symbol);
    if (home) return home;
    for (const s of FUTURES_SOURCE_PRIORITY) {
      if (this.sources[s].instruments.has(symbol)) return s;
    }
    return 'binance';
  }

  /** 为符号选择供价源：归属源优先，其余按优先级补位（须「未挂起 + 价格史新鲜」） */
  private selectSource(symbol: string, now: number): FuturesSourceName | null {
    const home = this.homeOf(symbol);
    const order = [
      home,
      ...FUTURES_SOURCE_PRIORITY.filter((s) => s !== home),
    ];
    for (const s of order) {
      const st = this.sources[s];
      if (now < st.suspendUntil) continue;
      if (now - st.lastPriceAt > PRICE_FRESH_MS) continue;
      const hist = st.priceHist.get(symbol);
      if (!hist || hist.length === 0) continue;
      const last = hist[hist.length - 1];
      if (now - last.t > PRICE_FRESH_MS || !(last.p > 0)) continue;
      return s;
    }
    return null;
  }

  /** 重建聚合行情：白名单 = 币安 U 本位永续（只做币安包含的品种） */
  private rebuildMerged(): void {
    this.assignShards(); // 首次统计就绪时分配（幂等）
    const now = Date.now();
    const whitelist = this.sources.binance.instruments;
    for (const [symbol, ins] of whitelist) {
      if (isExcludedBase(ins.base)) {
        this.merged.delete(symbol); // 稳定币对 / 代币化股票等（USDC 永续等）
        continue;
      }
      const sel = this.selectSource(symbol, now);
      if (!sel) {
        this.merged.delete(symbol); // 全源无新鲜数据 → 移出（恢复后自动回来）
        continue;
      }
      const st = this.sources[sel];
      const hist = st.priceHist.get(symbol)!;
      const lastPt = hist[hist.length - 1];
      const price = lastPt.p;
      const prevPt = hist.length >= 2 ? hist[hist.length - 2] : null;
      const s24 = st.stats24.get(symbol);
      // 24h 成交额跨源取最大：统一门槛/分层口径（Gate/Bybit 口径成交额系统性低于币安，
      // 按供价源口径会误杀尾部标的）。vol1m/量比保持供价源内部口径（与 K 线基线同源自洽）。
      let qv24 = s24?.qv24 ?? 0;
      for (const src of FUTURES_SOURCE_PRIORITY) {
        const cand = this.sources[src].stats24.get(symbol);
        if (cand && cand.qv24 > qv24) qv24 = cand.qv24;
      }
      const vs = st.volSamples.get(symbol) ?? [];
      let vol1m = 0;
      let volAvg20m = 0;
      if (vs.length >= 5) {
        const window = vs.slice(-21, -1); // 过去 20 个完整分钟
        volAvg20m = window.reduce((acc, x) => acc + x.qv, 0) / window.length;
        vol1m = vs[vs.length - 1].qv;
      }
      const prevRow = this.merged.get(symbol);
      const tickDir: 1 | -1 | 0 =
        prevPt && price !== prevPt.p ? (price > prevPt.p ? 1 : -1) : (prevRow?.tickDir ?? 0);
      const row: MergedRow = {
        symbol,
        base: ins.base,
        price,
        open: s24?.open24 || price,
        high24h: s24?.high24 || price,
        low24h: s24?.low24 || price,
        change24h: s24?.chg24 ?? 0,
        quoteVolume24h: qv24,
        chg1m: chgSince(hist, now - 60_000, price),
        chg5m: chgSince(hist, now - 5 * 60_000, price),
        chg15m: chgSince(hist, now - 15 * 60_000, price),
        chg1h: chgSince(hist, now - 60 * 60_000, price),
        vol1m: vol1m > 0 ? vol1m : null,
        volMultiple: volAvg20m > 0 && vol1m > 0 ? vol1m / volAvg20m : null,
        tickDir,
        hotTags: null,
        updatedAt: st.lastPriceAt || now,
        source: sel,
      };
      this.merged.set(symbol, row);
    }
  }

  // ============ 对外查询 ============

  getTickers(): TickerSnapshot[] {
    const out: TickerSnapshot[] = [];
    for (const row of this.merged.values()) {
      if (row.quoteVolume24h < MIN_QV_DISPLAY) continue;
      out.push({ ...row });
    }
    return out;
  }

  hasSymbol(symbol: string): boolean {
    return this.merged.has(symbol);
  }

  /** 该符号当前供价源（K 线同源取数优先用它，保证价/图一致） */
  sourceOf(symbol: string): FuturesSourceName | null {
    return this.merged.get(symbol)?.source ?? null;
  }

  /** 归属分片（对外查询：测试/诊断用） */
  shardOf(symbol: string): FuturesSourceName | null {
    return this.shards.get(symbol) ?? null;
  }

  /** 分片是否已就绪（引擎冷启动回填按归属均摊前需等待） */
  isSharded(): boolean {
    return this.shards.size > 0;
  }

  /** tickSize（按优先级取第一个有清单的源） */
  tickSizeOf(symbol: string): number {
    for (const s of FUTURES_SOURCE_PRIORITY) {
      const ins = this.sources[s].instruments.get(symbol);
      if (ins && ins.tickSize > 0) return ins.tickSize;
    }
    return 0;
  }

  getSourcesHealth(): FuturesSourceHealth[] {
    const now = Date.now();
    return FUTURES_SOURCE_PRIORITY.map((source) => {
      const st = this.sources[source];
      let symbols = 0;
      for (const row of this.merged.values()) if (row.source === source) symbols++;
      let homeSymbols = 0;
      for (const home of this.shards.values()) if (home === source) homeSymbols++;
      return {
        source,
        label: SOURCE_LABEL[source],
        ok: now - st.lastPriceAt < PRICE_FRESH_MS && st.instruments.size > 0,
        suspended: now < st.suspendUntil,
        bannedUntil: st.bannedUntil,
        lastPriceOkAt: st.lastPriceAt,
        last24hOkAt: st.last24hAt,
        symbols,
        homeSymbols,
        klineReqs: st.klineReqs,
        lastError: st.lastError,
      };
    });
  }

  // ============ K 线（异动引擎基线 + 图表共用；按符号同源取数） ============

  /** K 线取数顺序：归属源（分片）优先；兜底补位时非币安源优先，币安永远最后——
   *  （Task 51：K 线不全走币安，币安只背它分片那份 + 两所同时不可用时的末位兑底）。
   *  挂起中的源直接跳过——币安 418 封禁期间 K 线自动改走 Bybit/Gate，不在墙上硬撞 */
  private klineSourceOrder(symbol: string): FuturesSourceName[] {
    const now = Date.now();
    const order: FuturesSourceName[] = [];
    const home = this.homeOf(symbol);
    if (now >= this.sources[home].suspendUntil) order.push(home);
    const others = FUTURES_SOURCE_PRIORITY.filter((s) => s !== home).sort(
      (a, b) => (a === 'binance' ? 1 : 0) - (b === 'binance' ? 1 : 0),
    );
    for (const s of others) {
      if (now < this.sources[s].suspendUntil) continue;
      if (!this.sources[s].instruments.has(symbol)) continue;
      order.push(s);
    }
    return order;
  }

  /** 取 K 线并告知实际来源（回填播种需要同源写入价格史，保持「单源供价」不变式） */
  async fetchKlinesFrom(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
    opts: KlinesOpts,
  ): Promise<{ source: FuturesSourceName; candles: FuturesCandle[] }> {
    for (const s of this.klineSourceOrder(symbol)) {
      const ins = this.sources[s].instruments.get(symbol);
      if (!ins) continue;
      this.sources[s].klineReqs++; // 分片分配观测：实际承接的 K 线请求计数
      try {
        const candles = await fetchKlines(s, ins.native, interval, opts);
        if (candles.length > 0) return { source: s, candles };
      } catch {
        // 换下一源
      }
    }
    throw new Error(`合约 K 线不可用：${symbol}`);
  }

  async fetchKlinesFor(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
    opts: KlinesOpts,
  ): Promise<FuturesCandle[]> {
    return (await this.fetchKlinesFrom(symbol, interval, opts)).candles;
  }

  // ============ 启动回填：Top120 的 1m K 线 → chg1m/chg5m 即刻可用 ============

  private async backfillTop(): Promise<void> {
    try {
      for (let i = 0; i < 30 && this.merged.size === 0; i++) await sleep(1000);
      if (this.merged.size === 0) return;
      // 已有 ≥20 个价格点的标的跳过（bump key 交接/HMR 后不重复回填）
      const top = [...this.merged.values()]
        .filter((r) => {
          if (r.quoteVolume24h < 1_000_000) return false;
          const hist = this.sources[r.source]?.priceHist.get(r.symbol);
          return !hist || hist.length < 20;
        })
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
        .slice(0, TOP_BACKFILL);
      if (top.length === 0) return;
      const now = Date.now();
      let cursor = 0;
      const worker = async () => {
        while (cursor < top.length) {
          const row = top[cursor++];
          try {
            const res = await this.fetchKlinesFrom(row.symbol, '1m', { limit: 75 });
            this.seedHistory(row, res.source, res.candles, now);
          } catch {
            // 单币种失败忽略
          }
          await sleep(300); // 温和节流：与引擎回填错峰，防币安 fapi 418 限频
        }
      };
      await Promise.all(Array.from({ length: 2 }, worker)); // 并发 2（Task 50 节流）
    } catch {
      // 回填失败不影响后续实时采集
    }
  }

  /** 播种价格史/量能基线——只写「实际供 K 线的那个源」，避免跨源拼接 */
  private seedHistory(
    row: MergedRow,
    source: FuturesSourceName,
    candles: FuturesCandle[],
    now: number,
  ) {
    if (source !== row.source) return; // 供价源 K 线失败且降级 → 不播种（等实时累积）
    const st = this.sources[source];
    const hist: PricePoint[] = candles
      .filter((c) => Number.isFinite(c.c) && c.c > 0)
      .map((c) => ({ t: c.t, p: c.c }));
    if (hist.length > 0) {
      hist.push({ t: now, p: row.price });
      st.priceHist.set(row.symbol, hist);
    }
    const vs: { t: number; qv: number }[] = [];
    for (const c of candles) {
      if (c.t >= now - 21 * 60_000 && c.t + 60_000 <= now && Number.isFinite(c.qv)) {
        vs.push({ t: c.t, qv: c.qv });
      }
    }
    if (vs.length >= 4) st.volSamples.set(row.symbol, vs);
  }
}

// ---------- 全局单例（HMR 安全，同 Task 44/collector 规则） ----------
// v4（Task 60）：封禁升级根治——418/429 解析服务方 retry-after/banned until，挂满整个
// 封禁期（bannedUntil 硬截止：挂起期内偶发成功不提前解锁、instruments 刷新停手、
// bump 重建继承封禁状态不探针）。旧 3 分钟短挂起会反复撞墙，每次 418 刷新币安累犯
// 计数、把封禁时长一路升级（实测 24h）。v3（Task 51 续）：K 线兜底「非币安优先，
// 币安末位」+ klineReqs 计数 + isSharded 门控。v1/v2 已退役。
const g = globalThis as typeof globalThis & {
  __binanceRadarFutures_v1?: FuturesCollector; // v1：全量币安供价（Task 50，已退役）
  __binanceRadarFutures_v2?: FuturesCollector; // v2：分片首版（K 线兜底仍偏币安，已退役）
  __binanceRadarFutures_v3?: FuturesCollector; // v3：兜底重排（418 短挂起旧纪律，已退役）
  __binanceRadarFutures_v4?: FuturesCollector;
  __binanceRadarFuturesActive?: FuturesCollector;
};

function clearFuturesTimers(c: unknown): void {
  const legacy = c as {
    priceTimer?: ReturnType<typeof setInterval> | null;
    tfTimer?: ReturnType<typeof setInterval> | null;
  } | null;
  if (!legacy) return;
  if (legacy.priceTimer) clearInterval(legacy.priceTimer);
  if (legacy.tfTimer) clearInterval(legacy.tfTimer);
  legacy.priceTimer = null;
  legacy.tfTimer = null;
}

export const futuresCollector: FuturesCollector = (() => {
  const existing = g.__binanceRadarFutures_v4;
  if (existing) {
    g.__binanceRadarFuturesActive = existing; // 每次图评估都刷新稳定别名
    return existing;
  }
  const legacy = g.__binanceRadarFutures_v3 ?? g.__binanceRadarFutures_v2 ?? g.__binanceRadarFutures_v1;
  if (legacy) clearFuturesTimers(legacy); // 遗留实例停表
  const fresh = new FuturesCollector(legacy); // 状态交接（清单/价格史/统计/分片/封禁状态）
  g.__binanceRadarFutures_v4 = fresh;
  g.__binanceRadarFuturesActive = fresh;
  return fresh;
})();

/** 跨引擎动态解析活跃实例（paper / enhanced 引用一律走这里，Task 44 规则） */
export function activeFuturesCollector(): FuturesCollector {
  return g.__binanceRadarFuturesActive ?? futuresCollector;
}

export { clearFuturesTimers };
