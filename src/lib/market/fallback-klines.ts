/**
 * K 线兜底源：币安双市场熔断时图表仍可显示（Task 27）。
 * 兜底链：gate.io（加密现货对，2000+）→ Yahoo 财经（美股股票代币/裸代码合约 + 少量主流加密）。
 * 响应统一映射为 KlinePoint（t/o/h/l/c/v/qv），失败返回 null 由调用方继续降级。
 */
import type { KlinePoint } from '@/lib/market/types';
import { isStockBase } from './tradfi';

const GATE_BASE = 'https://api.gateio.ws';
const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Yahoo 兜底加密标的（与 collector.refreshYahoo 的映射一致；gate 覆盖不到时才会用到）
const YAHOO_CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB']);

/** Yahoo 周期映射（Yahoo 无 4h → 拉 60m 聚合 ×4；range 上限受 Yahoo 数据窗口约束） */
const YAHOO_MAP: Record<string, { iv: string; range: string; agg?: number }> = {
  '1m': { iv: '1m', range: '2d' },
  '5m': { iv: '5m', range: '5d' },
  '15m': { iv: '15m', range: '1mo' },
  '30m': { iv: '30m', range: '1mo' },
  '1h': { iv: '60m', range: '3mo' },
  '4h': { iv: '60m', range: '1y', agg: 4 },
  '1d': { iv: '1d', range: '2y' },
};

/** 细周期 K 线按 UTC 对齐聚合为粗周期（与币安 4h 对齐方式一致） */
function aggregate(rows: KlinePoint[], bucketMs: number): KlinePoint[] {
  const out: KlinePoint[] = [];
  let cur: KlinePoint | null = null;
  for (const r of rows) {
    const b = Math.floor(r.t / bucketMs) * bucketMs;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, qv: r.qv };
    } else {
      cur.h = Math.max(cur.h, r.h);
      cur.l = Math.min(cur.l, r.l);
      cur.c = r.c;
      cur.v += r.v;
      cur.qv += r.qv;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * gate.io 现货 K 线（仅加密币对；gate 无股票代币）。
 * 响应字段已实测：[T(秒), 报价量(USDT), C, H, L, O, 基础量, 是否走完]
 */
async function fetchGateKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<KlinePoint[] | null> {
  if (!symbol.endsWith('USDT')) return null;
  const pair = `${symbol.slice(0, -4)}_USDT`;
  try {
    const res = await fetch(
      `${GATE_BASE}/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${Math.min(limit, 999)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as string[][];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const rows = arr
      .map((k) => ({
        t: Number(k[0]) * 1000,
        o: Number(k[5]),
        h: Number(k[3]),
        l: Number(k[4]),
        c: Number(k[2]),
        v: Number(k[6]),
        qv: Number(k[1]),
      }))
      .filter((p) => Number.isFinite(p.c) && p.c > 0 && Number.isFinite(p.o) && p.o > 0);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Yahoo 财经 K 线：股票代币（AAPLB→AAPL）、美股裸代码合约（TSLA→TSLA）、主流加密（BTC→BTC-USD）。
 * 4h 用 60m 聚合补齐（Yahoo 无 4h 周期）。
 */
async function fetchYahooKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<KlinePoint[] | null> {
  if (!symbol.endsWith('USDT')) return null;
  const base = symbol.slice(0, -4);
  let ysym: string | null = null;
  if (isStockBase(base)) ysym = base.replace(/B$/, '');
  else if (YAHOO_CRYPTO.has(base)) ysym = `${base}-USD`;
  if (!ysym) return null;
  const m = YAHOO_MAP[interval];
  if (!m) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${m.iv}&range=${m.range}&includePrePost=false`;
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> } }> };
    };
    const r0 = j.chart?.result?.[0];
    const ts = r0?.timestamp;
    const q = r0?.indicators?.quote?.[0];
    if (!ts || !q) return null;
    const rows: KlinePoint[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (!Number.isFinite(c) || !c) continue;
      const o = q.open?.[i] ?? c;
      const h = q.high?.[i] ?? c;
      const l = q.low?.[i] ?? c;
      const v = q.volume?.[i] ?? 0;
      rows.push({ t: ts[i] * 1000, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v, qv: v * c });
    }
    if (rows.length === 0) return null;
    const out = m.agg ? aggregate(rows, m.agg * 3_600_000) : rows;
    return out.slice(-limit);
  } catch {
    return null;
  }
}

/** K 线兜底链入口：gate → Yahoo，全失败返回 null */
export async function fetchFallbackKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<{ data: KlinePoint[]; source: 'gate' | 'yahoo' } | null> {
  const gate = await fetchGateKlines(symbol, interval, limit);
  if (gate && gate.length >= 10) return { data: gate.slice(-limit), source: 'gate' };
  const yh = await fetchYahooKlines(symbol, interval, limit);
  if (yh && yh.length >= 10) return { data: yh, source: 'yahoo' };
  return null;
}
