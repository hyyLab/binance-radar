// 拉取每笔交易持仓期间的 1m K线，计算 MFE/MAE（最大浮盈/最大浮亏），验证「从赚到拿到亏」
// 数据源：Binance Futures 公开 API（与生产同一数据源语义）
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/rows-60.json', 'utf8'));

const LEV = 20;
const FEE_PCT_OF_MARGIN = 2.0; // 双边 taker 手续费占保证金百分比（20x × 0.05% × 2）
const SLIP_PCT_OF_MARGIN = 0.8; // 双边滑点 2bps 占保证金百分比

async function fetchKlines(symbol, startTime, endTime) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=60`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  return res.json();
}

async function main() {
  const out = [];
  let fail = 0;
  for (const r of rows) {
    const openAt = r.openAt - 60_000; // 提前1根，包含开仓那根K线
    const closeAt = r.closeAt + 60_000;
    try {
      const ks = await fetchKlines(r.symbol, openAt, closeAt);
      // 持仓期间（openedAt 之后）的K线
      const during = ks.filter((k) => k[0] >= Math.floor(r.openAt / 60000) * 60000 && k[0] <= r.closeAt);
      if (!during.length) {
        console.log(`SKIP ${r.symbol} 无持仓期K线`);
        fail++;
        continue;
      }
      const highs = during.map((k) => +k[2]);
      const lows = during.map((k) => +k[3]);
      const maxHigh = Math.max(...highs);
      const minLow = Math.min(...lows);
      const entry = r.entryPrice;
      // 以价格幅度计（正 = 有利方向）
      let mfePricePct, maePricePct;
      if (r.side === 'LONG') {
        mfePricePct = ((maxHigh - entry) / entry) * 100;
        maePricePct = ((minLow - entry) / entry) * 100;
      } else {
        mfePricePct = ((entry - minLow) / entry) * 100;
        maePricePct = ((entry - maxHigh) / entry) * 100;
      }
      // 换算成保证金收益率（20x 杠杆）
      const mfePctOfMargin = mfePricePct * LEV;
      const maePctOfMargin = maePricePct * LEV;
      // 开仓前趋势已经涨/跌了多少（从提前1根K线看入场点相对近期范围的位置）
      const preBars = ks.filter((k) => k[0] < Math.floor(r.openAt / 60000) * 60000).slice(-5);
      let preMove = 0;
      if (preBars.length >= 2) {
        const ref = +preBars[0][1];
        const lastClose = +preBars[preBars.length - 1][4];
        preMove = r.side === 'LONG' ? ((lastClose - ref) / ref) * 100 : ((ref - lastClose) / ref) * 100;
      }
      out.push({ ...r, mfePricePct, maePricePct, mfePctOfMargin, maePctOfMargin, preMove, barsHeld: during.length });
      process.stdout.write(`.`);
    } catch (e) {
      console.log(`\nFAIL ${r.symbol}: ${e.message}`);
      fail++;
    }
    await new Promise((res) => setTimeout(res, 120)); // 限速
  }
  console.log(`\nfetched ${out.length}/${rows.length} (fail ${fail})`);
  fs.writeFileSync('/home/z/my-project/scripts/trend-analysis/rows-mfe.json', JSON.stringify(out, null, 1));

  // ===== MFE 分析 =====
  const losers = out.filter((r) => r.net < 0);
  const winners = out.filter((r) => r.net > 0);
  console.log('\n===== 亏损单的 MFE（最大浮盈，占保证金%）=====');
  const buckets = [[0, 5], [5, 15], [15, 30], [30, 60], [60, 10000]];
  for (const [lo, hi] of buckets) {
    const g = losers.filter((r) => r.mfePctOfMargin >= lo && r.mfePctOfMargin < hi);
    if (!g.length) continue;
    console.log(`MFE ${lo}-${hi === 10000 ? '+' : hi}%: ${g.length} 笔 | 合计净 ${g.reduce((s, r) => s + r.net, 0).toFixed(2)} U`);
  }
  const everProfitable = losers.filter((r) => r.mfePctOfMargin > FEE_PCT_OF_MARGIN + SLIP_PCT_OF_MARGIN);
  console.log(`\n亏损单中「曾达到过盈利点（浮盈 > 摩擦成本 2.8% 保证金）」: ${everProfitable.length}/${losers.length} 笔`);
  const mfe10 = losers.filter((r) => r.mfePctOfMargin >= 10);
  console.log(`亏损单中「浮盈曾 ≥ 10% 保证金」: ${mfe10.length} 笔，合计浮亏转实亏 ${mfe10.reduce((s, r) => s + r.net, 0).toFixed(2)} U`);
  const mfe20 = losers.filter((r) => r.mfePctOfMargin >= 20);
  console.log(`亏损单中「浮盈曾 ≥ 20% 保证金」: ${mfe20.length} 笔，合计 ${mfe20.reduce((s, r) => s + r.net, 0).toFixed(2)} U`);
  if (mfe20.length) {
    mfe20.sort((a, b) => b.mfePctOfMargin - a.mfePctOfMargin).forEach((r) => {
      console.log(`  ${r.symbol} ${r.side} | MFE ${r.mfePctOfMargin.toFixed(0)}% → 最终 ${r.net.toFixed(2)} U | 持仓 ${r.holdMin.toFixed(1)} 分 | 价格峰 ${r.mfePricePct.toFixed(2)}%`);
    });
  }

  console.log('\n===== 盈利单的 MAE（最大浮亏，占保证金%）=====');
  for (const [lo, hi] of buckets) {
    const g = winners.filter((r) => r.maePctOfMargin >= lo && r.maePctOfMargin < hi);
    if (!g.length) continue;
    console.log(`MAE ${lo}-${hi === 10000 ? '+' : hi}%: ${g.length} 笔 | 合计净 ${g.reduce((s, r) => s + r.net, 0).toFixed(2)} U`);
  }

  console.log('\n===== 入场时机：入场前 5 分钟同方向波动（追高/追空程度）=====');
  const preBuckets = [[0, 0.2], [0.2, 0.5], [0.5, 1.0], [1.0, 99]];
  for (const [lo, hi] of preBuckets) {
    const g = out.filter((r) => r.preMove >= lo && r.preMove < hi);
    if (!g.length) continue;
    console.log(`入场前波动 ${lo}-${hi === 99 ? '+' : hi}%: ${g.length} 笔 | 盈利 ${g.filter((r) => r.net > 0).length} | 净 ${g.reduce((s, r) => s + r.net, 0).toFixed(2)} U`);
  }
}

main();
