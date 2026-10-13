// 短时验证：vol1m 是否随 24hr 差分更新（对照币安 1m K 线真实每分钟成交额）
const t0 = Date.now();
const DUR = 100_000;
const seen = new Map<string, { v: number; at: number }>();
const changes: string[] = [];

function bj(ms: number) { return new Date(ms + 8 * 3600_000).toISOString().slice(11, 19); }

async function main() {
  while (Date.now() - t0 < DUR) {
    try {
      const d = await (await fetch('http://localhost:3000/api/market/tickers', { cache: 'no-store' })).json();
      const now = Date.now();
      for (const sym of ['BTCUSDT', 'RSRUSDT']) {
        const row = (d.data ?? []).find((r: { symbol: string }) => r.symbol === sym);
        if (!row) continue;
        const s = seen.get(sym);
        if (!s) seen.set(sym, { v: row.vol1m, at: now });
        else if (row.vol1m !== s.v) {
          changes.push(`${bj(now)} ${sym} vol1m ${s.v.toFixed(0)} → ${row.vol1m.toFixed(0)}（间隔 ${((now - s.at) / 1000).toFixed(0)}s）`);
          seen.set(sym, { v: row.vol1m, at: now });
        }
      }
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(changes.length ? changes.join('\n') : '100s 内 vol1m 无任何变化（问题仍在）');
}
main().catch(console.error);
