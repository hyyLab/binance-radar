// ---------- USDT-M 合约行情源适配器（Binance / Bybit / Gate 多源容灾） ----------
// Task 50 定版：
//  - 品种范围 = 币安 U 本位永续白名单（PERPETUAL + USDT + TRADING）——只做币安包含的品种；
//  - Bybit / Gate 仅作为同一批符号的行情冗余源（行情大差不差、异动方向一致），
//    币安挂了自动降级到下一源，恢复后自动回到币安优先；
//  - 对外符号统一币安命名（BTCUSDT）；Gate 原生 BTC_USDT 在本层完成映射。
// K 线归一化：统一返回升序、t 为毫秒、qv 为计价成交额（USDT）——
//  币安 /fapi/v1/klines 与现货同构（[7]=quoteVolume，升序）；
//  Bybit v5 kline 倒序返回、[6]=turnover，需 reverse；
//  Gate candlesticks t 为秒、sum=计价成交额，需 ×1000 转毫秒。

import type { KlineInterval } from './binance';

export type FuturesSourceName = 'binance' | 'bybit' | 'gate';

/** 供价优先级：币安（模拟盘规则本体）> Bybit > Gate */
export const FUTURES_SOURCE_PRIORITY: readonly FuturesSourceName[] = [
  'binance',
  'bybit',
  'gate',
];

export const SOURCE_LABEL: Record<FuturesSourceName, string> = {
  binance: 'binanceU本位',
  bybit: 'Bybit',
  gate: 'Gate',
};

const BASES: Record<FuturesSourceName, string[]> = {
  binance: ['https://fapi.binance.com'],
  bybit: ['https://api.bybit.com', 'https://api.bytick.com'],
  gate: ['https://api.gateio.ws'],
};

const sticky: Record<FuturesSourceName, number> = { binance: 0, bybit: 0, gate: 0 };

export class FuturesFetchError extends Error {
  /** 418/429 限频封禁：服务方给出的解封等待毫秒（retry-after 头 / body banned until；无则 0）。
   *  Task 60：采集器据此挂起到解封为止——短挂起会反复撞墙，每次 418 都刷新币安
   *  累犯计数、把封禁时长一路升级（实测已被顶到 24h）。 */
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.name = 'FuturesFetchError';
    this.retryAfterMs = Math.max(0, Math.floor(retryAfterMs));
  }
}

// ============ 币安 fapi 全局权重令牌桶（Task 51 限流治理） ============
// 事前限速：所有 fapi 出站请求共享一个令牌桶（容量 80，8/s 补充 ≈ 480 权重/分钟），
// 请求前按「端点估算权重」扣令牌，不足则等待——轮询（~64/min）+ K 线轮换（~60/min）
// + 冷启动回填全部被压在 480/min 硬帽内，从机制上杜绝再触发 429→418 IP 封禁。
const BINANCE_BUCKET_CAPACITY = 80; // 突发容量（≥ 单次 24hr 全量轮询的权重 40×2）
const BINANCE_REFILL_PER_SEC = 8; // ≈ 480 权重/分钟（对实测敏感的 IP 留足余量）
let binanceTokens = BINANCE_BUCKET_CAPACITY;
let binanceLastRefill = Date.now();

async function takeBinanceTokens(cost: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    binanceTokens = Math.min(
      BINANCE_BUCKET_CAPACITY,
      binanceTokens + ((now - binanceLastRefill) / 1000) * BINANCE_REFILL_PER_SEC,
    );
    binanceLastRefill = now;
    if (binanceTokens >= cost) {
      binanceTokens -= cost;
      return;
    }
    await new Promise((r) => setTimeout(r, 250)); // 令牌不足，稍候再取
  }
}

/** 币安 fapi 各端点权重估算（官方文档口径） */
function estimateBinanceWeight(
  path: string,
  params?: Record<string, string | number | undefined>,
): number {
  if (path === '/fapi/v1/ticker/price') return params?.symbol ? 1 : 2;
  if (path === '/fapi/v1/ticker/24hr') return params?.symbol ? 1 : 40;
  if (path === '/fapi/v1/exchangeInfo') return 10;
  if (path === '/fapi/v1/klines') {
    const limit = Number(params?.limit ?? 500);
    if (limit < 100) return 1;
    if (limit < 500) return 2;
    if (limit <= 1000) return 5;
    return 10;
  }
  return 5; // 未知端点保守估计
}

/** 各源独立的多域名容灾请求（粘性记忆可用域名） */
async function sFetch<T>(
  source: FuturesSourceName,
  path: string,
  params?: Record<string, string | number | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const qs = params
    ? '?' +
      new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  const bases = BASES[source];
  let lastErr: unknown = null;
  // 币安出站先过全局令牌桶（按端点权重扣减）；Bybit/Gate 限制宽松不设桶
  if (source === 'binance') await takeBinanceTokens(estimateBinanceWeight(path, params));
  for (let i = 0; i < bases.length; i++) {
    const idx = (sticky[source] + i) % bases.length;
    try {
      const res = await fetch(bases[idx] + path + qs, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        // 418/429（币安 IP 封禁/限频）：读取解封等待——优先 body 的 banned until <epochMs>
        //（418 专属，最准），其次 retry-after 头（秒）；拿不到 = 0（调用方用默认短挂起）
        let retryAfterMs = 0;
        if (res.status === 418 || res.status === 429) {
          const raSec = Number(res.headers.get('retry-after'));
          if (Number.isFinite(raSec) && raSec > 0) retryAfterMs = raSec * 1000;
          try {
            const body = (await res.text()).slice(0, 500);
            const m = body.match(/banned until (\d{13})/);
            if (m) {
              const until = Number(m[1]);
              if (Number.isFinite(until)) retryAfterMs = Math.max(retryAfterMs, until - Date.now());
            }
          } catch {
            // body 读取失败不影响主错误抛出
          }
        }
        throw new FuturesFetchError(`HTTP ${res.status} @ ${bases[idx]}${path}`, retryAfterMs);
      }
      const json = (await res.json()) as T;
      sticky[source] = idx; // 记住可用域名
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new FuturesFetchError(`${source} fetch failed`);
}

// ============ 合约清单（品种白名单 + 精度） ============

export interface FuturesInstrument {
  native: string; // 源内原生符号（binance/bybit: BTCUSDT；gate: BTC_USDT）
  base: string;
  tickSize: number;
}

/** key = 归一化符号（币安命名 BTCUSDT） */
export type InstrumentsMap = Map<string, FuturesInstrument>;

/**
 * 拉取各源 USDT 永续合约清单。
 * 币安 = 白名单本体（PERPETUAL + USDT + TRADING，约 525 个）；
 * Bybit / Gate = 用于确定它们能覆盖白名单里哪些符号（名称映射 + tickSize）。
 */
export async function fetchInstruments(source: FuturesSourceName): Promise<InstrumentsMap> {
  const out: InstrumentsMap = new Map();
  if (source === 'binance') {
    const info = await sFetch<{
      symbols: {
        symbol: string;
        status: string;
        contractType: string;
        baseAsset: string;
        quoteAsset: string;
        filters: { filterType: string; tickSize?: string }[];
      }[];
    }>('binance', '/fapi/v1/exchangeInfo');
    for (const s of info.symbols) {
      if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT' || s.status !== 'TRADING') {
        continue;
      }
      const pf = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      out.set(s.symbol, {
        native: s.symbol,
        base: s.baseAsset,
        tickSize: pf?.tickSize ? Number(pf.tickSize) : 0,
      });
    }
  } else if (source === 'bybit') {
    // instruments-info 分页（limit 上限 1000，nextPageCursor 翻页）
    let cursor = '';
    for (let page = 0; page < 6; page++) {
      const r = await sFetch<{
        result: {
          list: {
            symbol: string;
            contractType: string;
            status: string;
            baseCoin: string;
            quoteCoin: string;
            priceFilter?: { tickSize?: string };
          }[];
          nextPageCursor?: string;
        };
      }>('bybit', '/v5/market/instruments-info', {
        category: 'linear',
        limit: 1000,
        cursor: cursor || undefined,
      });
      for (const s of r.result.list) {
        if (s.quoteCoin !== 'USDT' || s.contractType !== 'LinearPerpetual' || s.status !== 'Trading') {
          continue;
        }
        out.set(s.symbol, {
          native: s.symbol,
          base: s.baseCoin,
          tickSize: s.priceFilter?.tickSize ? Number(s.priceFilter.tickSize) : 0,
        });
      }
      cursor = r.result.nextPageCursor ?? '';
      if (!cursor) break;
    }
  } else {
    const list = await sFetch<
      { name: string; in_delisting: boolean; order_price_round: string }[]
    >('gate', '/api/v4/futures/usdt/contracts');
    for (const c of list) {
      if (c.in_delisting || !c.name.endsWith('_USDT')) continue;
      const norm = c.name.replace(/_USDT$/, 'USDT');
      out.set(norm, {
        native: c.name,
        base: norm.slice(0, -4),
        tickSize: Number(c.order_price_round) || 0,
      });
    }
  }
  return out;
}

// ============ 最新价（每 5s 轮询） ============

export interface PriceRow {
  symbol: string; // 归一化符号
  price: number;
}

/** 全量最新价（已按合约清单过滤，price > 0） */
export async function fetchPrices(
  source: FuturesSourceName,
  instruments: InstrumentsMap,
): Promise<PriceRow[]> {
  const rev = new Map<string, string>(); // native → 归一化
  for (const [norm, ins] of instruments) rev.set(ins.native, norm);
  const out: PriceRow[] = [];
  if (source === 'binance') {
    const rows = await sFetch<{ symbol: string; price: string }[]>(
      'binance',
      '/fapi/v1/ticker/price',
    );
    for (const r of rows) {
      const norm = rev.get(r.symbol);
      if (!norm) continue; // 交割合约（BTCUSDT_240927）等白名单外自动剔除
      const p = Number(r.price);
      if (Number.isFinite(p) && p > 0) out.push({ symbol: norm, price: p });
    }
  } else if (source === 'bybit') {
    const r = await sFetch<{ result: { list: { symbol: string; lastPrice: string }[] } }>(
      'bybit',
      '/v5/market/tickers',
      { category: 'linear' },
    );
    for (const t of r.result.list) {
      const norm = rev.get(t.symbol);
      if (!norm) continue;
      const p = Number(t.lastPrice);
      if (Number.isFinite(p) && p > 0) out.push({ symbol: norm, price: p });
    }
  } else {
    const rows = await sFetch<{ contract: string; last: string }[]>(
      'gate',
      '/api/v4/futures/usdt/tickers',
    );
    for (const t of rows) {
      const norm = rev.get(t.contract);
      if (!norm) continue;
      const p = Number(t.last);
      if (Number.isFinite(p) && p > 0) out.push({ symbol: norm, price: p });
    }
  }
  return out;
}

// ============ 24hr 统计（每 30s 轮询，供 24h 涨跌/高低点/成交额 + vol1m 差分） ============

export interface Stats24Row {
  symbol: string;
  qv24: number; // 24h 计价成交额 USDT
  chg24: number; // 24h 涨跌 %
  high24: number;
  low24: number;
  open24: number;
}

export async function fetch24h(
  source: FuturesSourceName,
  instruments: InstrumentsMap,
): Promise<Stats24Row[]> {
  const rev = new Map<string, string>();
  for (const [norm, ins] of instruments) rev.set(ins.native, norm);
  const out: Stats24Row[] = [];
  const push = (
    native: string,
    qv24: number,
    chg24: number,
    high24: number,
    low24: number,
    open24: number,
  ) => {
    const norm = rev.get(native);
    if (!norm) return;
    if (![qv24, chg24, high24, low24].every(Number.isFinite)) return;
    out.push({ symbol: norm, qv24, chg24, high24, low24, open24: open24 > 0 ? open24 : 0 });
  };
  if (source === 'binance') {
    const rows = await sFetch<
      {
        symbol: string;
        lastPrice: string;
        openPrice: string;
        highPrice: string;
        lowPrice: string;
        priceChangePercent: string;
        quoteVolume: string;
      }[]
    >('binance', '/fapi/v1/ticker/24hr');
    for (const r of rows) {
      push(
        r.symbol,
        Number(r.quoteVolume),
        Number(r.priceChangePercent),
        Number(r.highPrice),
        Number(r.lowPrice),
        Number(r.openPrice),
      );
    }
  } else if (source === 'bybit') {
    const r = await sFetch<{
      result: {
        list: {
          symbol: string;
          prevPrice24h: string;
          price24hPcnt: string;
          highPrice24h: string;
          lowPrice24h: string;
          turnover24h: string;
        }[];
      };
    }>('bybit', '/v5/market/tickers', { category: 'linear' });
    for (const t of r.result.list) {
      const pcnt = Number(t.price24hPcnt); // 小数（-0.0137 = -1.37%）
      push(
        t.symbol,
        Number(t.turnover24h),
        Number.isFinite(pcnt) ? pcnt * 100 : NaN,
        Number(t.highPrice24h),
        Number(t.lowPrice24h),
        Number(t.prevPrice24h),
      );
    }
  } else {
    const rows = await sFetch<
      {
        contract: string;
        last: string;
        change_percentage: string;
        high_24h: string;
        low_24h: string;
        volume_24h_quote: string;
      }[]
    >('gate', '/api/v4/futures/usdt/tickers');
    for (const t of rows) {
      const last = Number(t.last);
      const chg = Number(t.change_percentage); // 已是百分数（-1.31）
      // gate 无 24h 开盘字段：open ≈ last / (1 + chg%)（仅展示用）
      const open = Number.isFinite(last) && Number.isFinite(chg) && last > 0 && 1 + chg / 100 !== 0
        ? last / (1 + chg / 100)
        : 0;
      push(
        t.contract,
        Number(t.volume_24h_quote),
        chg,
        Number(t.high_24h),
        Number(t.low_24h),
        open,
      );
    }
  }
  return out;
}

// ============ K 线（统一升序 / t 毫秒 / qv 计价成交额） ============

export interface FuturesCandle {
  t: number; // openTime ms
  o: number;
  h: number;
  l: number;
  c: number;
  qv: number; // 计价成交额 USDT
}

const BYBIT_INTERVAL: Record<KlineInterval, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

export interface KlinesOpts {
  limit: number;
  endMs?: number; // 取该时刻之前的 K 线（向旧翻页）
  startMs?: number; // 取该时刻之后的 K 线（增量轮换）
}

export async function fetchKlines(
  source: FuturesSourceName,
  native: string,
  interval: KlineInterval,
  opts: KlinesOpts,
): Promise<FuturesCandle[]> {
  const { limit, endMs, startMs } = opts;
  let raw: FuturesCandle[];
  if (source === 'binance') {
    const rows = await sFetch<unknown[][]>('binance', '/fapi/v1/klines', {
      symbol: native,
      interval,
      limit,
      endTime: endMs,
      startTime: startMs,
    });
    raw = rows.map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      qv: Number(r[7]),
    }));
  } else if (source === 'bybit') {
    const r = await sFetch<{ result: { list: string[][] } }>('bybit', '/v5/market/kline', {
      category: 'linear',
      symbol: native,
      interval: BYBIT_INTERVAL[interval],
      limit,
      end: endMs,
      start: startMs,
    });
    // bybit 倒序返回 → reverse；[start, open, high, low, close, volume, turnover]
    raw = [...r.result.list]
      .reverse()
      .map((k) => ({
        t: Number(k[0]),
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        qv: Number(k[6]),
      }));
  } else {
    const rows = await sFetch<
      { t: number; o: string; h: string; l: string; c: string; v: number; sum: string }[]
    >('gate', '/api/v4/futures/usdt/candlesticks', {
      contract: native,
      interval,
      limit,
      to: endMs !== undefined ? Math.floor(endMs / 1000) : undefined,
      from: startMs !== undefined ? Math.floor(startMs / 1000) : undefined,
    });
    raw = rows.map((k) => ({
      t: k.t * 1000, // 秒 → 毫秒
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
      qv: Number(k.sum),
    }));
  }
  return raw.filter((c) => c.t > 0 && Number.isFinite(c.c) && Number.isFinite(c.qv));
}
