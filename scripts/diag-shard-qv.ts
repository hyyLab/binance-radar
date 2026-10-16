// Task 51 诊断：各源对关键符号的 24h 原始数据（只读，一次请求/源）
async function jf(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return res.json();
}

const targets = ['1000SHIBUSDT', '1000PEPEUSDT', 'BTCUSDT', 'DOGEUSDT'];

// Bybit
const bb = await jf('https://api.bybit.com/v5/market/tickers?category=linear');
const bbList = bb.result.list;
for (const t of targets) {
  const r = bbList.find((x: any) => x.symbol === t);
  console.log('[bybit]', t, r ? { last: r.lastPrice, turnover24h: Math.round(Number(r.turnover24h)) } : 'NOT FOUND');
}

// Gate（归一化对比：只查白名单命名相同的）
const gg = await jf('https://api.gateio.ws/api/v4/futures/usdt/tickers');
for (const t of targets) {
  const gateName = t === '1000SHIBUSDT' ? 'SHIB_USDT' : t === '1000PEPEUSDT' ? 'PEPE_USDT' : t;
  const r = gg.find((x: any) => x.contract === gateName);
  console.log('[gate]', t, `(${gateName})`, r ? { last: r.last, qv_quote: Math.round(Number(r.volume_24h_quote)) } : 'NOT FOUND');
}

// 币安（可能仍被封）
try {
  const bn = await jf('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=1000SHIBUSDT');
  console.log('[binance] 1000SHIBUSDT', { qv: Math.round(Number(bn.quoteVolume)) });
} catch (e) {
  console.log('[binance] FAILED(可能仍在封禁):', String(e).slice(0, 80));
}
