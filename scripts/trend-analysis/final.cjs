// 合并版（限速友好）：每 symbol 一次请求覆盖整个分析窗口，本地计算
// MFE/MAE + 入场前追价 + 趋势年龄 + 全部分组
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/rows-60.json', 'utf8'));
const trades = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/trades-60.json', 'utf8'));

const LEV = 20;

async function main() {
  // signalAtOpen 快照（按索引对应）
  const sigs = trades.map((t) => {
    try { return JSON.parse(t.meta.signalAtOpen); } catch { return null; }
  });

  // 每 symbol 一次请求：窗口 04:35 → 05:36 UTC（覆盖全部交易 + 5分钟前置 + 趋势起点回溯）
  const WIN_START = Date.UTC(2026, 9, 17, 4, 35, 0);
  const WIN_END = Date.UTC(2026, 9, 17, 5, 36, 0);
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const klineMap = new Map();
  for (const sym of symbols) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${WIN_START}&endTime=${WIN_END}&limit=100`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`HTTP ${res.status} ${sym}`); continue; }
      klineMap.set(sym, await res.json());
      process.stdout.write(`.`);
    } catch (e) {
      console.log(`FAIL ${sym}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2200));
  }
  console.log(`\nkline fetched for ${klineMap.size}/${symbols.length} symbols`);

  // 本地计算
  const results = rows.map((r0, i) => {
    const r = { ...r0 };
    const sig = sigs[i];
    r.sigScore = sig?.score ?? null;
    r.sigConfirmCount = sig?.confirmCount ?? null;
    r.trendStart = sig?.trendStartedAt ?? null;
    const openBar = Math.floor(r.openAt / 60000) * 60000;
    r.openBar = openBar;
    const ks = klineMap.get(r.symbol) ?? [];
    const entry = r.entryPrice;
    const during = ks.filter((k) => k[0] >= openBar && k[0] <= r.closeAt);
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
    // 入场前 5 分钟同方向波动（追价程度：入场前价格已经朝趋势方向走了多少）
    const pre = ks.filter((k) => k[0] < openBar).slice(-6, -1);
    if (pre.length >= 2) {
      const ref = +pre[0][1];
      const lastClose = +pre[pre.length - 1][4];
      r.preMove = r.side === 'LONG' ? ((lastClose - ref) / ref) * 100 : ((ref - lastClose) / ref) * 100;
    }
    // 趋势年龄：trendStartedAt → 开仓
    r.trendAgeMin = r.trendStart ? (r.openAt - r.trendStart) / 60000 : null;
    // 趋势开始→开仓的价格已走幅度（开在趋势的什么位置）
    if (r.trendStart && ks.length) {
      const refK = ks.filter((k) => k[0] <= r.trendStart);
      if (refK.length) {
        const ref = +refK[0][1];
        r.chasePct = r.side === 'LONG' ? ((entry - ref) / ref) * 100 : ((ref - entry) / ref) * 100;
      }
    }
    return r;
  });

  fs.writeFileSync('/home/z/my-project/scripts/trend-analysis/rows-final.json', JSON.stringify(results, null, 1));
  const sum = (a) => a.reduce((s, r) => s + r.net, 0);
  const winners = results.filter((r) => r.net > 0);
  const losers = results.filter((r) => r.net < 0);

  console.log('\n===== 盈利单 MAE（最大浮亏占保证金%）——赢的单承受了多少逆向波动 =====');
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

  console.log('\n===== 亏损单 MFE（曾达到的最大浮盈占保证金%）——「从赚到拿到亏」验证 =====');
  const posBuckets = [[0, 3], [3, 8], [8, 15], [15, 30], [30, 60], [60, 10000]];
  for (const [lo, hi] of posBuckets) {
    const g = losers.filter((r) => r.mfePctOfMargin >= lo && r.mfePctOfMargin < hi);
    if (!g.length) continue;
    console.log(`MFE ${lo}~${hi === 10000 ? '+' : hi}%: ${g.length} 笔 | 合计净 ${sum(g).toFixed(2)} U`);
  }
  const mfeBreakEven = losers.filter((r) => r.mfePctOfMargin >= 2.8);
  console.log(`亏损单中浮盈曾覆盖摩擦成本(≥2.8%)的: ${mfeBreakEven.length}/${losers.length} 笔 | 若在浮盈峰值离场的理论合计 ${(mfeBreakEven.reduce((s, r) => s + r.mfePctOfMargin / 100 * r.margin, 0)).toFixed(2)} U`);
  const mfe10 = losers.filter((r) => r.mfePctOfMargin >= 10);
  console.log(`亏损单中浮盈曾≥10%保证金的: ${mfe10.length} 笔 | 合计最终实亏 ${sum(mfe10).toFixed(2)} U`);

  console.log('\n===== 入场前5分钟同方向波动（追价程度）=====');
  const preBuckets = [[-99, 0], [0, 0.15], [0.15, 0.3], [0.3, 0.5], [0.5, 99]];
  for (const [lo, hi] of preBuckets) {
    const g = results.filter((r) => r.preMove != null && r.preMove >= lo && r.preMove < hi);
    if (!g.length) continue;
    console.log(`前5分钟同向波动 ${lo}~${hi === 99 ? '+' : hi}%: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }

  console.log('\n===== 趋势开始→开仓已走幅度 chasePct（开在趋势的什么位置）=====');
  const chaseBuckets = [[-99, 0], [0, 0.3], [0.3, 0.6], [0.6, 1.0], [1.0, 99]];
  for (const [lo, hi] of chaseBuckets) {
    const g = results.filter((r) => r.chasePct != null && r.chasePct >= lo && r.chasePct < hi);
    if (!g.length) continue;
    console.log(`已走 ${lo}~${hi === 99 ? '+' : hi}%: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }

  console.log('\n===== 趋势年龄（趋势确认→开仓延迟）=====');
  const ageBuckets = [[0, 1], [1, 2], [2, 4], [4, 8], [8, 999]];
  for (const [lo, hi] of ageBuckets) {
    const g = results.filter((r) => r.trendAgeMin != null && r.trendAgeMin >= lo && r.trendAgeMin < hi);
    if (!g.length) continue;
    console.log(`趋势年龄 ${lo}~${hi === 999 ? '+' : hi} 分钟: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }

  console.log('\n===== 开仓时信号 score（sigScore）=====');
  const ccBuckets = [[0, 40], [40, 55], [55, 70], [70, 85], [85, 999]];
  for (const [lo, hi] of ccBuckets) {
    const g = results.filter((r) => r.sigScore != null && r.sigScore >= lo && r.sigScore < hi);
    if (!g.length) continue;
    console.log(`score ${lo}~${hi === 999 ? '+' : hi}: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }

  console.log('\n===== 开仓时 confirmCount =====');
  const cBuckets = [[0, 3], [3, 5], [5, 8], [8, 999]];
  for (const [lo, hi] of cBuckets) {
    const g = results.filter((r) => r.sigConfirmCount != null && r.sigConfirmCount >= lo && r.sigConfirmCount < hi);
    if (!g.length) continue;
    console.log(`confirmCount ${lo}~${hi === 999 ? '+' : hi}: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${sum(g).toFixed(2)} U`);
  }

  // MFE>0 但被 END_PENDING 立即平掉的典型（展示「从赚到拿到亏」案例）
  console.log('\n===== 「从赚到拿到亏」典型明细（MFE≥10% 最终为亏）=====');
  mfe10.sort((a, b) => b.mfePctOfMargin - a.mfePctOfMargin).forEach((r) => {
    console.log(`${r.symbol} ${r.side} | MFE ${r.mfePctOfMargin.toFixed(0)}% / MAE ${r.maePctOfMargin.toFixed(0)}% → 最终 ${r.net.toFixed(2)} U | 持仓 ${r.holdMin.toFixed(1)} 分 | ${r.exitReason}/${r.exitPhase} | score开=${r.scoreAtOpen}`);
  });
}

main();
