// Task 50 探测脚本：验证 Binance U本位 / Bybit linear / Gate USDT 合约三数据源
// 输出各源合约数量、字段命名、分页方式，为多源适配器定型
const out = (k: string, v: unknown) => console.log(k, typeof v === 'object' ? JSON.stringify(v) : v);

async function jf(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// ---------- 1. Binance USDT-M ----------
try {
  const ex = await jf('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const perps = ex.symbols.filter(
    (s: any) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING',
  );
  out('[binance] perp+usdt+trading:', perps.length);
  out('[binance] sample filters:', {
    symbol: perps[0].symbol,
    base: perps[0].baseAsset,
    tickSize: perps[0].filters.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize,
  });
  const bases = new Set(perps.map((s: any) => s.baseAsset));
  const stables = [...bases].filter((b) =>
    ['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'PYUSD', 'EUR', 'EURI', 'USD1', 'USDE', 'USDS', 'BUSD', 'AEUR'].includes(b as string),
  );
  out('[binance] stable bases:', stables);
  const tk = await jf('https://fapi.binance.com/fapi/v1/ticker/price');
  const withUnderscore = tk.filter((t: any) => t.symbol.includes('_'));
  out('[binance] ticker/price rows:', tk.length, '含下划线(交割等):', withUnderscore.length, '样例:', withUnderscore[0]?.symbol);
} catch (e) {
  out('[binance] FAILED:', String(e));
}

// ---------- 2. Bybit linear ----------
try {
  let cursor = '';
  let all: any[] = [];
  for (let page = 0; page < 5; page++) {
    const u = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await jf(u);
    all = all.concat(r.result.list);
    cursor = r.result.nextPageCursor ?? '';
    out(`[bybit] page${page + 1}:`, r.result.list.length, 'cursor?', !!cursor);
    if (!cursor) break;
  }
  const usable = all.filter(
    (s: any) => s.quoteCoin === 'USDT' && s.contractType === 'LinearPerpetual' && s.status === 'Trading',
  );
  out('[bybit] usable perp usdt:', usable.length, 'tickSize 样例:', usable[0]?.priceFilter?.tickSize, usable[0]?.symbol);
  const tk = await jf('https://api.bybit.com/v5/market/tickers?category=linear');
  const usdtTk = tk.result.list.filter((t: any) => t.symbol.endsWith('USDT'));
  out('[bybit] tickers usdt rows:', usdtTk.length, '字段:', Object.keys(tk.result.list[0]).join(','));
} catch (e) {
  out('[bybit] FAILED:', String(e));
}

// ---------- 3. Gate USDT 合约 ----------
try {
  const ct = await jf('https://api.gateio.ws/api/v4/futures/usdt/contracts');
  out('[gate] contracts:', ct.length, 'in_delisting:', ct.filter((c: any) => c.in_delisting).length);
  out('[gate] contract 字段:', Object.keys(ct[0]).slice(0, 20).join(','));
  out('[gate] 样例:', { name: ct[0].name, round: ct[0].order_price_round, mult: ct[0].quanto_multiplier });
  const thousand = ct.filter((c: any) => /1000|SHIB|PEPE|BONK|SATS|FLOKI/i.test(c.name)).map((c: any) => c.name);
  out('[gate] 1000式命名样例:', thousand.slice(0, 12));
  const gtk = await jf('https://api.gateio.ws/api/v4/futures/usdt/tickers');
  const alive = gtk.filter((t: any) => Number(t.last) > 0);
  out('[gate] tickers rows:', gtk.length, 'last>0:', alive.length, '字段:', Object.keys(gtk[0]).join(','));
} catch (e) {
  out('[gate] FAILED:', String(e));
}
console.log('probe done');
