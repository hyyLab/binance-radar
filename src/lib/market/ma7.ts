// ---------- MA(7) 沿线趋势扫描引擎 ----------
// 目标：捕捉「K 线沿 MA7 均线顺势拉升 / 下跌」的币种（六周期 1m/3m/5m/15m/30m/1h）
// 单周期成线（analyzeMa7Tf）需同时满足：
//   1) MA7 同向倾斜：近端 SLOPE_BARS 根 MA7 斜率方向与趋势一致
//   2) 连续性：最近连续 ≥4 根【已收盘】K 线收盘价站在 MA7 同侧（streak，新鲜度优先）
//   3) 贴线不远离：现价相对 MA7 偏离在 [-0.6%, +7%]（多头）/ [-7%, +0.6%]（空头）
// 主导周期：折算成线时长（streak × 周期分钟）最长者；并列取更短周期
// 上榜门槛：≥2 个周期同向成线（aligned ≥ ALIGNED_MIN）
// 关键位 keyLevel：多头 = 连续段内最近一次贴线 K 线的低点（支撑）；
//            空头 = 最近一次贴线 K 线的高点（压力）；无贴线回退为当前 MA7 值
// 重扫频率 60s；宇宙 = 24h 成交额 Top100（剔除股票/商品代币，≥50 万 USDT）
// 币安权重预算：100 币 × 6 周期 × w2 = 1200/分钟（+行情采集约 450）≈ 1650 / 6000，安全
// 单例（globalThis 驻留），结果缓存在内存

import { bFetch, type KlineRow } from './binance';
import { collector } from './collector';
import { isExcludedBase } from './excluded';
import type { TickerSnapshot } from './types';

export const MA7_TFS = ['1m', '3m', '5m', '15m', '30m', '1h'] as const;
export type Ma7Tf = (typeof MA7_TFS)[number];

export const TF_MINUTES: Record<Ma7Tf, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
};

// ---- 可调参数 ----
export const MA7_WINDOW = 26; // 参与分析的已收盘 K 线数（SMA7 有效点 = 26-6 = 20）
const STREAK_MIN = 4; // 至少连续 4 根收盘站上/下 MA7
const SLOPE_BARS = 3; // MA7 斜率观察跨度（根）
const STRETCH_MAX = 7; // 顺向最大偏离 %（多头向上 / 空头向下）
const STRETCH_MIN = -0.6; // 逆向容忍偏离 %（略破 MA7 仍算沿线）
const TOUCH_BAND = 0.004; // 贴线判定带宽 ±0.4%
const KL_LIMIT = 60; // 每周期拉取 K 线根数
const SCAN_INTERVAL_MS = 60_000; // 重扫间隔 1 分钟
const UNIVERSE_CAP = 100; // 扫描宇宙上限（24h 成交额 Top100）
const MIN_QV = 500_000; // 宇宙门槛：24h 成交额 ≥ 50 万 USDT
const CONCURRENCY = 8; // 币种级并发 worker
export const ALIGNED_MIN = 2; // 上榜门槛：≥2 周期成线
const FRESH_MAX_MIN = 180; // 刚启动：折算成线时长 ≤ 3h
const EARLY_MAX_MIN = 600; // 早期：≤ 10h（> 10h 为延续中）
const RESEEN_GRACE_MS = 5 * 60_000; // 掉榜 5 分钟内重新上榜，保留首次发现时间
const LIST_CAP = 60; // 最多展示行数
const SEEN_TTL_MS = 30 * 60_000; // 掉榜记忆清理阈值

export type Ma7Phase = 'FRESH' | 'EARLY' | 'MATURE';

export interface Ma7TfResult {
  tf: Ma7Tf;
  dir: 'UP' | 'DOWN';
  streak: number; // 连续收盘站上/下 MA7 的已收盘 K 线数
  holdRatio: number; // streak / 分析窗口
  stretchPct: number; // 现价相对当前 MA7 的偏离 %
  slopePct: number; // MA7 近端斜率 %
  touches: number; // 沿线贴线次数（影线触及 MA7 ±0.4%）
  keyLevel: number; // 关键位：多头=最近贴线 low（支撑）/ 空头=最近贴线 high（压力）
}

/**
 * 分析单个周期是否「沿 MA7 成线」。
 * kl 为币安原始 K 线数组（最后一根可能是未收盘的进行时 K 线，内部会剔除）。
 */
export function analyzeMa7Tf(tf: Ma7Tf, kl: KlineRow[], livePrice: number): Ma7TfResult | null {
  const now = Date.now();
  const closed = kl.filter((k) => k[6] <= now); // 只统计已收盘 K 线
  if (closed.length < MA7_WINDOW || livePrice <= 0) return null;
  const use = closed.slice(-MA7_WINDOW);
  const closes = use.map((k) => Number(k[4]));

  // SMA7 序列（索引 i ≥ 6 才有值，共 WINDOW-6 个点）
  const mas: number[] = [];
  for (let i = 6; i < closes.length; i++) {
    let s = 0;
    for (let j = i - 6; j <= i; j++) s += closes[j];
    mas.push(s / 7);
  }
  if (mas.length < SLOPE_BARS + 1) return null;

  // streak：从最后一根已收盘 K 线向前连续计数
  const lastClose = closes[closes.length - 1];
  const lastMa = mas[mas.length - 1];
  const dir: 'UP' | 'DOWN' = lastClose >= lastMa ? 'UP' : 'DOWN';
  let streak = 0;
  for (let i = mas.length - 1; i >= 0; i--) {
    const c = closes[i + 6];
    const m = mas[i];
    if (dir === 'UP' ? c > m : c < m) streak++;
    else break;
  }
  if (streak < STREAK_MIN) return null;

  // MA7 斜率（近端 SLOPE_BARS 根），必须与趋势同向
  const maRef = mas[mas.length - 1 - SLOPE_BARS];
  const slopePct = ((lastMa - maRef) / maRef) * 100;
  if (dir === 'UP' ? slopePct <= 0 : slopePct >= 0) return null;

  // 现价偏离：顺向 ≤ 7%，逆向容忍 -0.6%
  const stretchPct = ((livePrice - lastMa) / lastMa) * 100;
  if (dir === 'UP') {
    if (stretchPct < STRETCH_MIN || stretchPct > STRETCH_MAX) return null;
  } else {
    if (stretchPct > -STRETCH_MIN || stretchPct < -STRETCH_MAX) return null;
  }

  // 贴线次数 + 关键位（连续段内从最近往前找第一根触及 MA7 带的 K 线）
  let touches = 0;
  let keyLevel = lastMa; // 缺省：当前 MA7 值
  let keyFound = false;
  for (let i = mas.length - 1; i >= mas.length - streak; i--) {
    const k = use[i + 6];
    const low = Number(k[3]);
    const high = Number(k[2]);
    const m = mas[i];
    if (dir === 'UP') {
      if (low <= m * (1 + TOUCH_BAND)) {
        touches++;
        if (!keyFound) {
          keyLevel = low; // 最近一次贴线未破的低点 = 支撑
          keyFound = true;
        }
      }
    } else {
      if (high >= m * (1 - TOUCH_BAND)) {
        touches++;
        if (!keyFound) {
          keyLevel = high; // 最近一次贴线未破的高点 = 压力
          keyFound = true;
        }
      }
    }
  }

  return {
    tf,
    dir,
    streak,
    holdRatio: streak / mas.length,
    stretchPct,
    slopePct,
    touches,
    keyLevel,
  };
}

// ---------- 行构建 ----------

export interface Ma7TfState {
  tf: Ma7Tf;
  dir: 'UP' | 'DOWN' | null; // null = 该周期未成线
  rideMin: number; // 折算成线时长（分钟）
}

export interface Ma7Row {
  symbol: string;
  base: string;
  price: number;
  change24h: number;
  quoteVolume24h: number;
  tfStates: Ma7TfState[]; // 六周期成线状态（按周期升序）
  upCount: number;
  downCount: number;
  aligned: number; // 同向成线周期数 = max(up, down)
  dir: 'UP' | 'DOWN'; // 主导方向（多数侧；并列时取折算时长更长侧）
  leadTf: Ma7Tf; // 主导周期（折算时长最长，并列取更短周期）
  maxRideMin: number; // 主导周期折算成线时长（分钟）
  phase: Ma7Phase;
  touches: number; // 主导周期贴线次数
  score: number; // 综合强度分（展示用）
  label: string; // 描述文案
  keyLevel: number; // 关键位：UP=支撑 / DOWN=压力（保证趋势正常运行的位）
  detectedAt: number; // 本会话首次上榜时间
}

const rideMinOf = (r: Ma7TfResult) => r.streak * TF_MINUTES[r.tf];

export function buildMa7Row(
  symbol: string,
  base: string,
  meta: { price: number; change24h: number; quoteVolume24h: number },
  results: Array<Ma7TfResult | null>,
  detectedAt: number,
): Ma7Row | null {
  const qualified = results.filter((r): r is Ma7TfResult => r !== null);
  let upCount = 0;
  let downCount = 0;
  for (const r of qualified) {
    if (r.dir === 'UP') upCount++;
    else downCount++;
  }
  const aligned = Math.max(upCount, downCount);
  if (aligned < ALIGNED_MIN) return null;

  const sideMax = (side: 'UP' | 'DOWN') =>
    qualified.filter((r) => r.dir === side).reduce((mx, r) => Math.max(mx, rideMinOf(r)), 0);

  let dir: 'UP' | 'DOWN';
  if (upCount > downCount) dir = 'UP';
  else if (downCount > upCount) dir = 'DOWN';
  else dir = sideMax('UP') >= sideMax('DOWN') ? 'UP' : 'DOWN';

  const sideResults = qualified.filter((r) => r.dir === dir);
  // 主导周期：折算时长最长；并列取更短周期（更早发现的新鲜信号）
  const lead = [...sideResults].sort(
    (a, b) => rideMinOf(b) - rideMinOf(a) || TF_MINUTES[a.tf] - TF_MINUTES[b.tf],
  )[0];
  const maxRideMin = rideMinOf(lead);

  const phase: Ma7Phase =
    maxRideMin <= FRESH_MAX_MIN ? 'FRESH' : maxRideMin <= EARLY_MAX_MIN ? 'EARLY' : 'MATURE';

  const score =
    aligned * 10 +
    Math.min(lead.touches, 6) * 2 +
    (phase === 'FRESH' ? 6 : phase === 'EARLY' ? 3 : 0) +
    (qualified.length === MA7_TFS.length ? 8 : 0) +
    Math.min(meta.quoteVolume24h / 1e7, 5); // 流动性微加权

  const dn = dir === 'DOWN';
  const label =
    (aligned === MA7_TFS.length ? '六周期全线' : `${aligned} 周期共振`) +
    (dn ? '沿 MA7 下行' : '沿 MA7 上行');

  const tfStates: Ma7TfState[] = MA7_TFS.map((tf) => {
    const r = qualified.find((x) => x.tf === tf);
    return r ? { tf, dir: r.dir, rideMin: rideMinOf(r) } : { tf, dir: null, rideMin: 0 };
  });

  return {
    symbol,
    base,
    price: meta.price,
    change24h: meta.change24h,
    quoteVolume24h: meta.quoteVolume24h,
    tfStates,
    upCount,
    downCount,
    aligned,
    dir,
    leadTf: lead.tf,
    maxRideMin,
    phase,
    touches: lead.touches,
    score: Math.round(score * 10) / 10,
    label,
    keyLevel: lead.keyLevel,
    detectedAt,
  };
}

// ---------- 扫描器 ----------

export interface Ma7Status {
  scanning: boolean;
  lastScanAt: number;
  universe: number; // 本轮覆盖币种数
  listed: number; // 上榜行数
  intervalSec: number; // 重扫间隔（秒）
  startedAt: number;
  lastError: string;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export class Ma7Scanner {
  private rows: Ma7Row[] = [];
  private scanning = false;
  private lastScanAt = 0;
  private universeCount = 0;
  private started = false;
  private starting: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, { first: number; last: number }>(); // 上榜记忆
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
      this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
      await this.scan().catch(() => {});
    })();
    await Promise.race([this.starting, sleep(8000)]);
  }

  getStatus(): Ma7Status {
    return {
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      universe: this.universeCount,
      listed: this.rows.length,
      intervalSec: SCAN_INTERVAL_MS / 1000,
      startedAt: this.meta.startedAt,
      lastError: this.meta.lastError,
    };
  }

  getRows(): Ma7Row[] {
    return this.rows;
  }

  /** 扫描宇宙：24h 成交额 Top100（剔除股票/商品代币与低成交额币种） */
  private universe(): TickerSnapshot[] {
    return collector
      .getTickers()
      .filter((t) => t.quoteVolume24h >= MIN_QV && !isExcludedBase(t.base))
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, UNIVERSE_CAP);
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const symbols = this.universe();
      this.universeCount = symbols.length;
      const now = Date.now();
      const out: Ma7Row[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < symbols.length) {
          const t = symbols[cursor++];
          try {
            // 单币种六周期并行拉取，外层 8 worker 并发
            const kls = await Promise.all(
              MA7_TFS.map((tf) =>
                bFetch<KlineRow[]>('/api/v3/klines', {
                  symbol: t.symbol,
                  interval: tf,
                  limit: KL_LIMIT,
                }),
              ),
            );
            const results = kls.map((kl, i) => analyzeMa7Tf(MA7_TFS[i], kl, t.price));
            const prev = this.seen.get(t.symbol);
            const detectedAt = prev && now - prev.last <= RESEEN_GRACE_MS ? prev.first : now;
            const row = buildMa7Row(t.symbol, t.base, t, results, detectedAt);
            if (row) {
              this.seen.set(t.symbol, { first: detectedAt, last: now });
              out.push(row);
            }
          } catch {
            // 单币种失败忽略
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      for (const [sym, v] of this.seen) {
        if (now - v.last > SEEN_TTL_MS) this.seen.delete(sym);
      }
      // 默认排序：折算成线时长升序（刚启动的排前面）
      this.rows = out
        .sort((a, b) => a.maxRideMin - b.maxRideMin || b.aligned - a.aligned)
        .slice(0, LIST_CAP);
      this.lastScanAt = Date.now();
      this.meta.lastError = '';
    } catch (e) {
      this.meta.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.scanning = false;
    }
  }
}

const g = globalThis as typeof globalThis & {
  __binanceRadarMa7?: Ma7Scanner;
};

export const ma7Scanner: Ma7Scanner = (g.__binanceRadarMa7 ??= new Ma7Scanner());
