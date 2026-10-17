// 补充统计：总保证金投入 / 每symbol盈亏 / 平衡表
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/rows-final.json', 'utf8'));

const totalMargin = rows.reduce((s, r) => s + r.margin, 0);
const totalFees = rows.reduce((s, r) => s + r.fees, 0);
const totalSlip = rows.reduce((s, r) => s + (r.net - r.pnl), 0);
const totalNet = rows.reduce((s, r) => s + r.net, 0);
const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
const purePrice = totalPnl + totalFees; // pnl 已含手续费 → 纯价格盈亏 = pnl + fees
console.log(`总保证金投入: ${totalMargin.toFixed(2)} U（60 笔，平均 ${(totalMargin / 60).toFixed(2)} U/笔）`);
console.log(`净盈亏 ${totalNet.toFixed(2)} = 引擎pnl(含费) ${totalPnl.toFixed(2)} + 滑点 ${totalSlip.toFixed(2)}`);
console.log(`其中: 手续费 ${totalFees.toFixed(2)} U | 滑点 ${totalSlip.toFixed(2)} U | 纯价格盈亏 ${purePrice.toFixed(2)} U`);
console.log(`摩擦占净亏比: ${((totalFees + totalSlip) / Math.abs(totalNet) * 100).toFixed(0)}%`);
console.log(`摩擦占投入保证金比: ${((totalFees + totalSlip) / totalMargin * 100).toFixed(2)}%（每笔往返约 2.8% 保证金）`);

console.log('\n===== 每symbol盈亏 =====');
const bySym = {};
for (const r of rows) {
  bySym[r.symbol] = bySym[r.symbol] || { n: 0, net: 0, wins: 0, holdSum: 0 };
  bySym[r.symbol].n++; bySym[r.symbol].net += r.net; bySym[r.symbol].holdSum += r.holdMin;
  if (r.net > 0) bySym[r.symbol].wins++;
}
Object.entries(bySym).sort((a, b) => a[1].net - b[1].net).forEach(([s, v]) => {
  console.log(`${s}: ${v.n} 笔 | 盈利 ${v.wins} | 净 ${v.net.toFixed(2)} U | 平均持仓 ${(v.holdSum / v.n).toFixed(1)} 分`);
});

// 「从赚到拿到亏」量化：所有 60 笔如果都在 MFE 峰值的 50% 离场（理论）
const losers = rows.filter((r) => r.net < 0);
const recoverable = losers.filter((r) => (r.mfePctOfMargin ?? 0) >= 10);
console.log(`\n亏损单中浮盈曾≥10%保证金的 ${recoverable.length} 笔：最终实亏 ${recoverable.reduce((s, r) => s + r.net, 0).toFixed(2)} U，浮盈峰值合计 ${recoverable.reduce((s, r) => s + r.mfePctOfMargin / 100 * r.margin, 0).toFixed(2)} U`);

// 赢单/亏单持仓时长对比
const winners = rows.filter((r) => r.net > 0);
console.log(`\n盈利单平均持仓 ${(winners.reduce((s, r) => s + r.holdMin, 0) / winners.length).toFixed(1)} 分钟`);
console.log(`亏损单平均持仓 ${(losers.reduce((s, r) => s + r.holdMin, 0) / losers.length).toFixed(1)} 分钟`);
