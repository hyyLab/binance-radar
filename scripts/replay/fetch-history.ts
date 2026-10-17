// ---------- 历史回放 · 数据获取（Task 54 §六） ----------
// 用法：bun scripts/replay/fetch-history.ts [--symbols BTCUSDT,SOLUSDT,...] [--days 3]
// 数据源：仅 Bybit/Gate 公共行情（不触碰币安——与运行中服务的 418 治理互不干扰）。
// 输出：scripts/replay/data/<SYMBOL>.json（1m K 线升序，t=开盘毫秒，原始 OHLCV+计价额）。
// 说明：这是回放专用脚本，独立于运行中的服务；自带 200ms 间隔限速。

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const DATA_DIR = '/home/z/my-project/scripts/replay/data';

const args = process.argv.slice(2);
function argOf(name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const SYMBOLS = argOf('--symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,XRPUSDT,SUIUSDT,PEPEUSDT,WIFUSDT,TIAUSDT,ORDIUSDT,LTCUSDT,AVAXUSDT').split(',');
const DAYS = Number(argOf('--days', '3'));

interface Bar { t: number; o: number; h: number; l: number; c: number; qv: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBybit1m(symbol: string, endMs: number, limit: number): Promise<Bar[]> {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=${limit}&end=${endMs}`;
  const r = await fetch(url);
  const j = (await r.json()) as { retCode: number; result?: { list?: string[][] } };
  if (j.retCode !== 0 || !j.result?.list) return [];
  return j.result.list
    .map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), qv: Number(k[6]) }))
    .sort((a, b) => a.t - b.t);
}

function gateContract(symbol: string): string {
  // BTCUSDT → BTC_USDT；1000PEPEUSDT 等（币安 1000 前缀）在 Gate 无 1000 前缀
  const base = symbol.replace(/USDT$/, '').replace(/^1000/, '');
  return `${base}_USDT`;
}

async function fetchGate1m(symbol: string, toSec: number, limit: number): Promise<Bar[]> {
  const contract = gateContract(symbol);
  const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=1m&limit=${limit}&to=${toSec}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const rows = (await r.json()) as { t: number; o: string; h: string; l: string; c: string; sum: string }[];
  return rows
    .map((k) => ({ t: k.t * 1000, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), qv: Number(k.sum) }))
    .sort((a, b) => a.t - b.t);
}

async function fetchAll(symbol: string, startMs: number, endMs: Promise<Bar[]> | number): Promise<Bar[]> {
  const end = typeof endMs === 'number' ? endMs : Date.now();
  const out: Bar[] = [];
  let cursor = end;
  while (cursor > startMs) {
    let batch = await fetchBybit1m(symbol, cursor, 1000);
    if (batch.length === 0) batch = await fetchGate1m(symbol, Math.floor(cursor / 1000), 1000);
    if (batch.length === 0) break;
    out.push(...batch);
    cursor = batch[0]!.t - 1;
    if (batch.length < 500) break; // 已到历史尽头
    await sleep(200);
  }
  // 去重 + 排序 + 截取窗口
  const seen = new Set<number>();
  return out
    .filter((b) => b.t > startMs && b.t <= end && !seen.has(b.t) && seen.add(b.t))
    .sort((a, b) => a.t - b.t);
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 3600_000;
  for (const symbol of SYMBOLS) {
    const file = `${DATA_DIR}/${symbol}.json`;
    if (existsSync(file)) {
      console.log(`跳过（已存在）：${symbol}`);
      continue;
    }
    try {
      const bars = await fetchAll(symbol, startMs, endMs);
      if (bars.length < 1000) {
        console.log(`✗ ${symbol}: 仅 ${bars.length} 根，数据不足（可能两所均无此合约）`);
        continue;
      }
      writeFileSync(file, JSON.stringify(bars));
      console.log(`✓ ${symbol}: ${bars.length} 根 1m（${((bars[bars.length - 1]!.t - bars[0]!.t) / 3600_000).toFixed(1)}h）`);
    } catch (e) {
      console.log(`✗ ${symbol}: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(200);
  }
  console.log('完成 →', DATA_DIR);
}

void main();
