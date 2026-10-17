// 修正版 v2：MFE/MAE + 入场前追价 + 趋势年龄（trendStartedAt→开仓）
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/rows-60.json', 'utf8'));
const trades = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/trades-60.json', 'utf8'));

const LEV = 20;

async function fetchKlines(symbol, startTime, endTime) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  return res.json();
}

async function main() {
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const r = { ...rows[i] };
    // signalAtOpen（开仓时刻的完整信号快照）
    let sig = null;
    try { sig = JSON.parse(trades[i].meta.signalAtOpen); } catch {}
    const trendStart = sig?.trendStartedAt ?? null;
    const openBar = Math.floor(r.openAt / 60000) * 60000;
    const startFetch = Math.min(openBar - 12 * 60_000, (trendStart ?? openBar) - 60_000);
    try {
      const ks = await fetchKlines(r.symbol, startFetch, r.closeAt + 60_000);
      const during = ks.filter((k) => k[0] >= openBar && k[0] <= r.closeAt);
      const entry = r.entryPrice;
      if (during.length) {
        const maxHigh = Math.max(...during.map((k) => +k[2]));
        const minLow = Math.min(...during.map((k) => +k[3]));
        if (r.side === 'LONG') {
          r.mfePricePct = ((maxHigh - entry) / entry) * 100;
          r.maePricePct = ((minLow - entry) / entry) * 100;
        } else {
          r.mfePricePct = ((entry - minLow) / entry) * 100;
          r.maePricePct = ((entry - maxHigh) / entry) * 100;
        }
        r.mfePctOfMargin = r.mfePricePct * LEV;
        r.maePctOfMargin = r.maePricePct * LEV;
      }
      // 入场前 5 分钟同方向波动（追价程度）
      const pre = ks.filter((k) => k[0] < openBar).slice(-6, -1);
      if (pre.length >= 2) {
        const ref = +pre[0][1];
        const lastClose = +pre[pre.length - 1][4];
        r.preMove = r.side === 'LONG' ? ((lastClose - ref) / ref) * 100 : ((ref - lastClose) / ref) * 100;
      }
      // 趋势年龄（分钟）：trendStartedAt → 开仓时刻
      r.trendAgeMin = trendStart ? (r.openAt - trendStart) / 60000 : null;
      r.sigConfirmCount = sig?.confirmCount ?? null;
      results.push(r);
      process.stdout.write('.');
    } catch (e) {
      console.log(`\nFAIL ${r.symbol}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  console.log(`\ndone ${results.length}/${rows.length}`);
  fs.writeFileSync('/home/z/my-project/scripts/trend-analysis/rows-mfe2.json', JSON.stringify(results, null, 1));

  const winners = results.filter((r) => r.net > 0);
  const losers = results.filter((r) => r.net < 0);
  const sum = (a) => a.reduce((s, r) => s + r.net, 0);

  console.log('\n===== 盈利单 MAE（最大浮亏占保证金%）=====');
  const negBuckets = [[-100, -30], [-30, -20], [-20, -10], [-10, -5], [-5, 0], [0, 100]];
  for (const [lo, hi] of negBuckets) {
    const g = winners.filter((r) => r.maePctOfMargin >= lo && r.maePctOfMargin < hi);
    if (!g.length) continue;
    console.log(`MAE ${lo}~${hi}%: ${g.length} 笔 | 合计净 ${sum(g).toFixed(2)} U`);
  }
  console.log('\n===== 亏损单 MAE =====');
  for (const [lo, hi] of negBuckets) {
    const g = losers.filter((r) => r.maePctOfMargin >= lo && r.maePctOfMargin < hi);
    if (!g.length) continue;
    console.log(`MAE ${lo}~${hi}%: ${g.length} 笔 | 合计净 ${sum(g).toFixed(2)} U`);
  }
  console.log('\n===== 入场前5分钟同方向波动（追价程度）=====');
  const preBuckets = [[-99, 0], [0, 0.2], [0.2, 0.4], [0.4, 0.8], [0.8, 99]];
  for (const [lo, hi] of preBuckets) {
    const g = results.filter((r) => r.preMove != null && r.preMove >= lo && r.preMove < hi);
    if (!g.length) continue;
    console.log(`前5分钟同向波动 ${lo}~${hi === 99 ? '+' : hi}%: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }
  console.log('\n===== 趋势年龄（趋势确认→开仓延迟）=====');
  const ageBuckets = [[0, 1], [1, 2], [2, 4], [4, 8], [8, 999]];
  for (const [lo, hi] of ageBuckets) {
    const g = results.filter((r) => r.trendAgeMin != null && r.trendAgeMin >= lo && r.trendAgeMin < hi);
    if (!g.length) continue;
    console.log(`趋势年龄 ${lo}~${hi === 999 ? '+' : hi} 分钟: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }
  console.log('\n===== 开仓时 confirmCount =====');
  const ccBuckets = [[0, 3], [3, 5], [5, 8], [8, 999]];
  for (const [lo, hi] of ccBuckets) {
    const g = results.filter((r) => r.sigConfirmCount != null && r.sigConfirmCount >= lo && r.sigConfirmCount < hi);
    if (!g.length) continue;
    console.log(`confirmCount ${lo}~${hi === 999 ? '+' : hi}: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }
}

main();
