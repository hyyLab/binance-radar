// ---------- 币安公开行情 API 客户端（多域名容灾） ----------

const BASES = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
];

let activeBase = 0;

export class BinanceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceFetchError';
  }
}

/**
 * 请求币安公开接口。任一域名失败自动切换下一个（粘性记忆可用域名）。
 */
export async function bFetch<T>(
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

  let lastErr: unknown = null;
  for (let i = 0; i < BASES.length; i++) {
    const idx = (activeBase + i) % BASES.length;
    const base = BASES[idx];
    try {
      const res = await fetch(base + path + qs, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new BinanceFetchError(`HTTP ${res.status} @ ${base}${path}`);
      const json = (await res.json()) as T;
      activeBase = idx; // 记住可用域名
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new BinanceFetchError('binance fetch failed');
}

export const KLINE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type KlineInterval = (typeof KLINE_INTERVALS)[number];

// [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore]
export type KlineRow = [
  number, string, string, string, string, string, number, string, number, string, string, string,
];
