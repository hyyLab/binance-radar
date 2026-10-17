// 提取 END_PENDING 平仓的具体证据类型（exitSignalJson.reason 含 DECAY/REVERSE_CANDIDATE/STRUCTURE_ER 等）
const fs = require('fs');
const trades = JSON.parse(fs.readFileSync('/home/z/my-project/scripts/trend-analysis/trades-60.json', 'utf8'));

const byEv = {};
for (const t of trades) {
  if (t.meta.exitReason !== 'TREND_ENDED') continue;
  let sig = null;
  try { sig = JSON.parse(t.meta.exitSignalJson); } catch {}
  if (!sig) continue;
  const reason = sig.reason ?? '';
  // 证据类型：从 reason 提取（REVERSE_CANDIDATE / DECAY / STRUCTURE_ER / STRUCTURE_CONSIST）
  let ev = '-';
  const m = reason.match(/（([A-Z_]+)）/);
  if (m) ev = m[1];
  else if (reason.includes('反向')) ev = 'REVERSE';
  const key = `${sig.phase} | ${ev}`;
  byEv[key] = byEv[key] || { count: 0, net: 0, wins: 0, holdSum: 0, examples: [] };
  byEv[key].count++;
  byEv[key].net += t.meta.netPnlWithSlip ?? 0;
  if ((t.meta.netPnlWithSlip ?? 0) > 0) byEv[key].wins++;
  byEv[key].holdSum += (new Date(t.pos.closedAt) - new Date(t.pos.openedAt)) / 60000;
  byEv[key].examples.push(`${t.meta.symbol} ${t.meta.side} net=${(t.meta.netPnlWithSlip ?? 0).toFixed(2)} score=${t.meta.scoreAtOpen}→${sig.score} reason="${reason}"`);
}
for (const [k, v] of Object.entries(byEv)) {
  console.log(`\n${k}: ${v.count} 笔 | 盈利 ${v.wins} | 净 ${v.net.toFixed(2)} U | 平均持仓 ${(v.holdSum / v.count).toFixed(1)} 分`);
  v.examples.slice(0, 6).forEach((e) => console.log(`   ${e}`));
}

// 开仓时信号 score 与平仓时 score 对比（趋势衰减速度）
console.log('\n===== 开仓→平仓 score 变化 =====');
let dropFast = 0, dropFastNet = 0;
for (const t of trades) {
  let so = null, se = null;
  try { so = JSON.parse(t.meta.signalAtOpen); se = JSON.parse(t.meta.exitSignalJson); } catch {}
  if (!so || !se) continue;
  const d = se.score - so.score;
  if (d <= -30) { dropFast++; dropFastNet += t.meta.netPnlWithSlip ?? 0; }
}
console.log(`score 开→平 下降≥30 的: ${dropFast} 笔 | 净 ${dropFastNet.toFixed(2)} U`);

// 同一 symbol 被反复交易的频次
console.log('\n===== symbol 交易频次 TOP =====');
const freq = {};
for (const t of trades) freq[t.meta.symbol] = (freq[t.meta.symbol] ?? 0) + 1;
Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([s, c]) => console.log(`${s}: ${c} 次`));
