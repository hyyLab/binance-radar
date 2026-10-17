// 分析60条已平仓趋势交易：盈亏分布 / 平仓原因 / 持仓时长 / 开仓特征
const fs = require('fs');
const trades = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/trades-60.json', 'utf8'));

const rows = trades.map((t) => {
  const m = t.meta, p = t.pos || {};
  let exitSig = null;
  try { exitSig = m.exitSignalJson ? JSON.parse(m.exitSignalJson) : null; } catch {}
  let feat = {};
  try { feat = m.featuresAtOpen ? JSON.parse(m.featuresAtOpen) : {}; } catch {}
  const openAt = new Date(p.openedAt).getTime();
  const closeAt = new Date(p.closedAt).getTime();
  const holdMin = (closeAt - openAt) / 60000;
  const margin = p.margin || 0;
  const pnl = p.pnl || 0; // 引擎毛盈亏（已扣平仓手续费？看引擎定义：pnl 已扣 closeFee）
  const net = m.netPnlWithSlip || 0; // 含滑点净盈亏（保守口径）
  const priceMovePct = p.exitPrice && p.entryPrice ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100 * (p.side === 'LONG' ? 1 : -1) : 0;
  const fees = (p.openFee || 0) + (p.closeFee || 0);
  return {
    symbol: m.symbol, side: m.side,
    exitReason: m.exitReason,
    posStatus: p.status,
    holdMin,
    margin,
    pnl, net,
    fees,
    feePctOfMargin: (fees / margin) * 100,
    priceMovePct,
    pnlPctOfMargin: (pnl / margin) * 100,
    netPctOfMargin: (net / margin) * 100,
    scoreAtOpen: m.scoreAtOpen,
    strength: feat.strength,
    htfAgree: feat.htfAgree,
    volRegime: feat.vol?.volRegime ?? feat.volRegime,
    atrPct: feat.vol?.atrPct ?? feat.atrPct,
    efficiencyRatio: feat.vol?.efficiencyRatio ?? feat.efficiencyRatio,
    confirmCount: exitSig?.confirmCount,
    exitPhase: exitSig?.phase,
    exitEndReason: exitSig?.endReason,
    exitScore: exitSig?.score,
    openAt, closeAt,
    trendStartedAt: exitSig?.trendStartedAt,
    entryPrice: p.entryPrice, exitPrice: p.exitPrice, qty: p.qty, leverage: p.leverage,
    trendCycleId: m.trendCycleId,
  };
});

// ===== 1. 总览 =====
const n = rows.length;
const wins = rows.filter((r) => r.net > 0);
const losses = rows.filter((r) => r.net < 0);
const flat = rows.filter((r) => r.net === 0);
const sum = (a) => a.reduce((s, r) => s + r.net, 0);
console.log('===== 总览（含滑点净盈亏 netPnlWithSlip）=====');
console.log(`样本 ${n} 笔 | 盈利 ${wins.length} (${((wins.length/n)*100).toFixed(0)}%) | 亏损 ${losses.length} (${((losses.length/n)*100).toFixed(0)}%)`);
console.log(`净盈亏合计 ${sum(rows).toFixed(2)} U | 盈利合计 +${sum(wins).toFixed(2)} | 亏损合计 ${sum(losses).toFixed(2)}`);
console.log(`平均盈利 +${(sum(wins)/Math.max(wins.length,1)).toFixed(2)} | 平均亏损 ${(sum(losses)/Math.max(losses.length,1)).toFixed(2)} | 盈亏比 ${(Math.abs(sum(wins)/Math.max(wins.length,1)/ (sum(losses)/Math.max(losses.length,1)))).toFixed(2)}`);
console.log(`总手续费 ${rows.reduce((s,r)=>s+r.fees,0).toFixed(2)} U（占保证金比均值 ${rows.reduce((s,r)=>s+r.feePctOfMargin,0)/n .toFixed? '':''}）`);

// ===== 2. 按平仓原因分组 =====
console.log('\n===== 按平仓原因 =====');
const byReason = {};
for (const r of rows) {
  const key = `${r.exitReason}${r.posStatus === 'LIQUIDATED' ? '/强平' : ''}`;
  byReason[key] = byReason[key] || { count: 0, net: 0, pnl: 0, holdSum: 0, wins: 0 };
  byReason[key].count++;
  byReason[key].net += r.net;
  byReason[key].pnl += r.pnl;
  byReason[key].holdSum += r.holdMin;
  if (r.net > 0) byReason[key].wins++;
}
for (const [k, v] of Object.entries(byReason)) {
  console.log(`${k}: ${v.count} 笔 | 盈利 ${v.wins} | 净盈亏 ${v.net.toFixed(2)} U | 引擎毛盈亏 ${v.pnl.toFixed(2)} U | 平均持仓 ${(v.holdSum/v.count).toFixed(1)} 分钟`);
}

// ===== 3. 平仓原因 × 亏损笔数明细 =====
console.log('\n===== exitEndReason 细分（exitSignalJson.endReason）=====');
const byEnd = {};
for (const r of rows) {
  const key = `${r.exitReason} | end=${r.exitEndReason ?? '-'} | exitPhase=${r.exitPhase ?? '-'}`;
  byEnd[key] = byEnd[key] || { count: 0, net: 0, wins: 0 };
  byEnd[key].count++; byEnd[key].net += r.net; if (r.net > 0) byEnd[key].wins++;
}
for (const [k, v] of Object.entries(byEnd)) console.log(`${k}: ${v.count} 笔 | 盈利 ${v.wins} | 净 ${v.net.toFixed(2)} U`);

// ===== 4. 持仓时长分布 =====
console.log('\n===== 持仓时长（分钟）=====');
const buckets = [[0,2],[2,5],[5,10],[10,20],[20,60],[60,1e9]];
for (const [lo, hi] of buckets) {
  const g = rows.filter((r) => r.holdMin >= lo && r.holdMin < hi);
  if (!g.length) continue;
  console.log(`${lo}-${hi === 1e9 ? '+' : hi} 分钟: ${g.length} 笔 | 净 ${sum(g).toFixed(2)} U | 盈利 ${g.filter(r=>r.net>0).length} 笔`);
}
console.log(`平均持仓时长 ${(rows.reduce((s,r)=>s+r.holdMin,0)/n).toFixed(1)} 分钟 | 中位数 ${rows.map(r=>r.holdMin).sort((a,b)=>a-b)[Math.floor(n/2)].toFixed(1)} 分钟`);

// ===== 5. 手续费/滑点摩擦成本 =====
const totalFees = rows.reduce((s, r) => s + r.fees, 0);
const totalSlip = rows.reduce((s, r) => s + (r.net - r.pnl), 0);
console.log('\n===== 摩擦成本 =====');
console.log(`手续费合计 ${totalFees.toFixed(2)} U | 滑点合计 ${totalSlip.toFixed(2)} U | 合计 ${(totalFees+totalSlip).toFixed(2)} U`);
console.log(`若不计摩擦，净盈亏应为 ${sum(rows).toFixed(2)} U；含摩擦 ${sum(rows).toFixed(2)} U`);

// ===== 6. 开仓特征与盈亏的关系 =====
console.log('\n===== 开仓评分 scoreAtOpen 分组 =====');
const scoreBuckets = [[0,60],[60,70],[70,80],[80,101]];
for (const [lo, hi] of scoreBuckets) {
  const g = rows.filter((r) => r.scoreAtOpen >= lo && r.scoreAtOpen < hi);
  if (!g.length) continue;
  console.log(`score ${lo}-${hi}: ${g.length} 笔 | 盈利 ${g.filter(r=>r.net>0).length} | 净 ${sum(g).toFixed(2)} U | 平均净 ${(sum(g)/g.length).toFixed(2)}`);
}
console.log('\n===== htfAgree 分组 =====');
for (const v of [true, false, null]) {
  const g = rows.filter((r) => r.htfAgree === v);
  if (!g.length) continue;
  console.log(`htfAgree=${v}: ${g.length} 笔 | 盈利 ${g.filter(r=>r.net>0).length} | 净 ${sum(g).toFixed(2)} U`);
}
console.log('\n===== volRegime 分组 =====');
const vols = {};
for (const r of rows) { vols[r.volRegime] = vols[r.volRegime] || []; vols[r.volRegime].push(r); }
for (const [k, g] of Object.entries(vols)) {
  console.log(`volRegime=${k}: ${g.length} 笔 | 盈利 ${g.filter(r=>r.net>0).length} | 净 ${sum(g).toFixed(2)} U | 平均持仓 ${(g.reduce((s,r)=>s+r.holdMin,0)/g.length).toFixed(1)} 分`);
}
console.log('\n===== efficiencyRatio 分组 =====');
const erBuckets = [[0,0.3],[0.3,0.5],[0.5,0.7],[0.7,2]];
for (const [lo, hi] of erBuckets) {
  const g = rows.filter((r) => r.efficiencyRatio != null && r.efficiencyRatio >= lo && r.efficiencyRatio < hi);
  if (!g.length) continue;
  console.log(`ER ${lo}-${hi}: ${g.length} 笔 | 盈利 ${g.filter(r=>r.net>0).length} | 净 ${sum(g).toFixed(2)} U`);
}
console.log('\n===== atrPct 分组 =====');
const atrBuckets = [[0,0.15],[0.15,0.3],[0.3,0.6],[0.6,99]];
for (const [lo, hi] of atrBuckets) {
  const g = rows.filter((r) => r.atrPct != null && r.atrPct >= lo && r.atrPct < hi);
  if (!g.length) continue;
  console.log(`atrPct ${lo}-${hi}: ${g.length} 笔 | 盈利 ${g.filter(r=>r.net>0).length} | 净 ${sum(g).toFixed(2)} U`);
}

// ===== 7. 方向分布 =====
console.log('\n===== 多空方向 =====');
for (const s of ['LONG', 'SHORT']) {
  const g = rows.filter((r) => r.side === s);
  console.log(`${s}: ${g.length} 笔 | 盈利 ${g.filter(r=>r.net>0).length} | 净 ${sum(g).toFixed(2)} U`);
}

// ===== 8. 强平/大亏明细 =====
console.log('\n===== 亏损最大的 10 笔 =====');
[...rows].sort((a, b) => a.net - b.net).slice(0, 10).forEach((r) => {
  console.log(`${r.symbol} ${r.side} | ${r.exitReason}${r.posStatus==='LIQUIDATED'?'(强平)':''} | 净 ${r.net.toFixed(2)} U (${r.netPctOfMargin.toFixed(0)}% 保证金) | 持仓 ${r.holdMin.toFixed(1)} 分 | 价格变动 ${r.priceMovePct.toFixed(2)}% | score开=${r.scoreAtOpen} exit=${r.exitScore} | end=${r.exitEndReason}`);
});
console.log('\n===== 盈利最大的 10 笔 =====');
[...rows].sort((a, b) => b.net - a.net).slice(0, 10).forEach((r) => {
  console.log(`${r.symbol} ${r.side} | ${r.exitReason} | 净 ${r.net.toFixed(2)} U (${r.netPctOfMargin.toFixed(0)}% 保证金) | 持仓 ${r.holdMin.toFixed(1)} 分 | 价格变动 ${r.priceMovePct.toFixed(2)}% | score开=${r.scoreAtOpen} exit=${r.exitScore} | end=${r.exitEndReason}`);
});

// 保存分析后的行数据供后续 MFE 脚本使用
fs.writeFileSync('/home/z/my-project/scripts/trend-analysis/rows-60.json', JSON.stringify(rows, null, 1));
console.log('\nrows saved to rows-60.json');
