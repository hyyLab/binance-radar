// 实测 collector vol1m 的更新频率 vs 真实每分钟成交额（验证 dtMin>=0.7 丢样本问题）
const BASE = 'http://localhost:3000/api/market/tickers';
const DUR_MS = 210_000; // 3.5 分钟
const STEP_MS = 3_000;

interface Seen { val: number; at: number; }
const seen = new Map<string, Seen>();
const updates: { sym: string; at: string; val: number; gapS: number }[] = [];
const staleSamples: { sym: string; ageS: number; val: number }[] = [];

function bj(ms: number) { return new Date(ms + 8 * 3600_000).toISOString().slice(11, 19); }

async function main() {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < DUR_MS) {
    try {
      const res = await fetch(BASE, { cache: 'no-store' });
      const d = (await res.json()) as { data: { symbol: string; vol1m: number }[] };
      const now = Date.now();
      for (const sym of ['BTCUSDT', 'ETHUSDT', 'RSRUSDT']) {
        const row = d.data.find((r) => r.symbol === sym);
        if (!row) continue;
        const s = seen.get(sym);
        if (!s) {
          seen.set(sym, { val: row.vol1m, at: now });
        } else if (row.vol1m !== s.val) {
          updates.push({ sym, at: bj(now), val: row.vol1m, gapS: (now - s.at) / 1000 });
          seen.set(sym, { val: row.vol1m, at: now });
        } else {
          staleSamples.push({ sym, ageS: (now - s.at) / 1000, val: row.vol1m });
        }
      }
      n++;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, STEP_MS));
  }
  console.log(`采样 ${n} 次（每 3s，共 ${DUR_MS / 1000}s）\n`);
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'RSRUSDT']) {
    const ups = updates.filter((u) => u.sym === sym);
    const stale = staleSamples.filter((s) => s.sym === sym);
    const maxAge = stale.length ? Math.max(...stale.map((s) => s.ageS)) : 0;
    const avgAge = stale.length ? stale.reduce((a, s) => a + s.ageS, 0) / stale.length : 0;
    console.log(`=== ${sym} ===`);
    console.log(`vol1m 变更次数: ${ups.length}（${DUR_MS / 60000} 分钟内，理论应每分钟变 1-2 次）`);
    for (const u of ups) console.log(`  ${u.at} → ${u.val.toFixed(0)}（距上次变更 ${u.gapS.toFixed(0)}s）`);
    console.log(`采样点中 vol1m 的平均"年龄": ${avgAge.toFixed(0)}s，最大 ${maxAge.toFixed(0)}s`);
  }
}
main().catch(console.error);
