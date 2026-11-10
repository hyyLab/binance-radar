/** Task 85 查证:cashcat/icnt 退池平仓后的价格走势(多源公共API,仅查证用) */
const CASES = [
  { symbol: 'ICNTUSDT', closeAt: '2026-10-19T04:25:21.467Z', closePrice: 0.1745, entry: 0.1753, side: 'LONG' },
  { symbol: 'CASHCATUSDT', closeAt: '2026-10-19T04:20:01.444Z', closePrice: 0.10796, entry: 0.10834, side: 'LONG' },
];

const SOURCES = [
  (s: string, start: number, end: number) =>
    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=5&start=${start}&end=${end}&limit=200`,
  (s: string, start: number, end: number) =>
    `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${s.replace('USDT', '_USDT')}&from=${Math.floor(start / 1000)}&to=${Math.floor(end / 1000)}&interval=5m`,
];

for (const c of CASES) {
  const closeAt = Date.parse(c.closeAt);
  const end = closeAt + 3 * 3600_000; // 平仓后 3 小时
  let done = false;
  for (const mk of SOURCES) {
    if (done) break;
    try {
      const res = await fetch(mk(c.symbol, closeAt - 60_000, end));
      if (!res.ok) continue;
      const j: unknown = await res.json();
      const bars = Array.isArray(j)
        ? (j as Array<Record<string, unknown>>).map((b) => ({
            t: Number(b.time) * 1000,
            c: Number(b.close ?? b.c),
          }))
        : ((j as { result?: { list?: Array<Record<string, unknown>> } }).result?.list ?? []).map((b) => ({
            t: Number(b[0] ?? 0),
            c: Number(b[4]),
          }));
      const valid = bars.filter((b) => b.t >= closeAt && b.c > 0).sort((a, b) => a.t - b.t);
      if (valid.length < 5) continue;
      const hi = Math.max(...valid.map((b) => b.c));
      const hiAt = valid.find((b) => b.c === hi)?.t ?? 0;
      const last = valid[valid.length - 1].c;
      const pct = (x: number) => (((x - c.closePrice) / c.closePrice) * 100).toFixed(2);
      console.log(
        `${c.symbol} 平仓价 ${c.closePrice} → 平仓后3h最高 ${hi}(+${pct(hi)}%, ` +
          `${new Date(hiAt).toISOString()}) 现价 ${last}(+${pct(last)}%) bars=${valid.length}`,
      );
      done = true;
    } catch {
      // 下一数据源
    }
  }
  if (!done) console.log(`${c.symbol} 行情源均不可用(仅记用户口述结论)`);
}

export {};
