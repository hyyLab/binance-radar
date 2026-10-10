import { NextResponse } from 'next/server';
import { bFetch, KLINE_INTERVALS, type KlineInterval, type KlineRow } from '@/lib/market/binance';
import { collector } from '@/lib/market/collector';
import type { KlinesResponse, KlinePoint } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

// 简单服务端缓存：同一 (symbol,interval,limit) 20s 内复用
const cache = new Map<string, { at: number; data: KlinePoint[] }>();
const CACHE_TTL_MS = 20_000;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
    const interval = (url.searchParams.get('interval') ?? '15m') as KlineInterval;
    let limit = Number(url.searchParams.get('limit') ?? 180);

    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
      return NextResponse.json({ ok: false, error: 'invalid symbol' }, { status: 400 });
    }
    if (!KLINE_INTERVALS.includes(interval)) {
      return NextResponse.json({ ok: false, error: 'invalid interval' }, { status: 400 });
    }
    if (!Number.isFinite(limit) || limit < 30) limit = 30;
    if (limit > 500) limit = 500;

    // 等采集器就绪后校验交易对真实存在
    await collector.ensureStarted();
    if (!collector.hasSymbol(symbol)) {
      return NextResponse.json({ ok: false, error: 'unknown symbol' }, { status: 404 });
    }

    const key = `${symbol}|${interval}|${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      const res: KlinesResponse = { ok: true, symbol, interval, data: hit.data };
      return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
    }

    const rows = await bFetch<KlineRow[]>('/api/v3/klines', { symbol, interval, limit });
    const data: KlinePoint[] = rows.map((k) => ({
      t: Number(k[0]),
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: Number(k[5]),
      qv: Number(k[7]),
    }));

    cache.set(key, { at: Date.now(), data });
    if (cache.size > 500) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (now - v.at > CACHE_TTL_MS) cache.delete(k);
      }
    }

    const res: KlinesResponse = { ok: true, symbol, interval, data };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal error' },
      { status: 502 },
    );
  }
}
