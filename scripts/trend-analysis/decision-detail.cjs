// 对比开仓决策 detail（完整信号快照）与平仓信号，确认 ENDED 误杀竞态
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

async function main() {
  const rows = await db.$queryRawUnsafe(`
    SELECT * FROM TrendAutoDecision
    WHERE id IN ('AGTUSDT:L:1792215193583:OPEN', 'AGTUSDT:L:1792215193583:CLOSE')
       OR (symbol='AGTUSDT' AND cycleId='AGTUSDT:L:1792215193583')
    ORDER BY createdAt ASC
  `);
  for (const d of rows) {
    console.log(`\n==== ${d.id} | ${new Date(d.createdAt).toISOString()} ====`);
    try {
      const detail = JSON.parse(d.detail);
      const { phase, direction, score, confirmCount, trendStartedAt, lastBarTime, endReason: er, reason, changedAt, endPendingSince, endEvidenceBars } = detail;
      console.log(`  phase=${phase} dir=${direction} score=${score} confirmCount=${confirmCount}`);
      console.log(`  trendStartedAt=${trendStartedAt ? new Date(trendStartedAt).toISOString() : null} lastBarTime=${lastBarTime ? new Date(lastBarTime).toISOString() : null}`);
      if (er !== undefined) {
        console.log(`  [exit signal] endReason=${er} changedAt=${changedAt ? new Date(changedAt).toISOString() : null} endPendingSince=${endPendingSince} endEvidenceBars=${endEvidenceBars}`);
        console.log(`  reason=${reason}`);
      }
      if (detail.netPnl !== undefined) console.log(`  pnl=${detail.netPnl} exitPrice=${detail.exitPrice} reason=${detail.reason}`);
    } catch { console.log('  detail parse fail:', String(d.detail).slice(0, 200)); }
  }
  // 再看 DUSKUSDT:S:1792215166265 (持仓0.04分) 的开仓信号
  const rows2 = await db.$queryRawUnsafe(`
    SELECT * FROM TrendAutoDecision WHERE cycleId='DUSKUSDT:S:1792215166265' ORDER BY createdAt ASC
  `);
  for (const d of rows2) {
    console.log(`\n==== ${d.id} | ${new Date(d.createdAt).toISOString()} ====`);
    try {
      const detail = JSON.parse(d.detail);
      console.log(`  phase=${detail.phase} dir=${detail.direction} score=${detail.score} confirmCount=${detail.confirmCount}`);
      console.log(`  trendStartedAt=${detail.trendStartedAt ? new Date(detail.trendStartedAt).toISOString() : null} lastBarTime=${detail.lastBarTime ? new Date(detail.lastBarTime).toISOString() : null}`);
      if (detail.endReason !== undefined) {
        console.log(`  [exit] endReason=${detail.endReason} changedAt=${detail.changedAt ? new Date(detail.changedAt).toISOString() : null}`);
        console.log(`  reason=${detail.reason}`);
      }
      if (detail.netPnl !== undefined) console.log(`  pnl=${detail.netPnl}`);
    } catch { console.log('  detail parse fail:', String(d.detail).slice(0, 200)); }
  }
}

main().finally(() => db.$disconnect());
