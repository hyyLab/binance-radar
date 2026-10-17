// 查证「持仓几秒即 ENDED 平仓」的决策时间线（APTUSDT SHORT 案例）
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

async function main() {
  // 找出持仓 < 0.2 分钟且 exitPhase=ENDED 的交易
  const metas = await db.$queryRawUnsafe(`
    SELECT * FROM TrendTradeMeta WHERE status='CLOSED' ORDER BY closedAt DESC LIMIT 60
  `);
  const fast = [];
  for (const m of metas) {
    const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
    if (!pos) continue;
    const holdMin = (new Date(pos.closedAt) - new Date(pos.openedAt)) / 60000;
    let sig = null;
    try { sig = JSON.parse(m.exitSignalJson); } catch {}
    if (sig && sig.phase === 'ENDED' && holdMin < 0.3) {
      fast.push({ m, pos, holdMin, sig });
    }
  }
  console.log(`持仓<0.3分钟且以ENDED平仓的: ${fast.length} 笔\n`);
  for (const { m, pos, holdMin, sig } of fast.slice(0, 4)) {
    console.log(`==== ${m.symbol} ${m.side} | 持仓 ${holdMin.toFixed(2)} 分 ====`);
    console.log(`  开仓决策 openDecisionAt: ${m.openDecisionAt ? new Date(m.openDecisionAt).toISOString() : null}`);
    console.log(`  持仓 openedAt:  ${new Date(pos.openedAt).toISOString()}`);
    console.log(`  平仓 closedAt:  ${new Date(pos.closedAt).toISOString()}`);
    console.log(`  trendStartedAt: ${sig.trendStartedAt ? new Date(sig.trendStartedAt).toISOString() : null}`);
    console.log(`  endPendingSince: ${sig.endPendingSince ? new Date(sig.endPendingSince).toISOString() : null}`);
    console.log(`  endEvidenceBars: ${sig.endEvidenceBars} | changedAt: ${new Date(sig.changedAt).toISOString()}`);
    console.log(`  lastBarTime: ${sig.lastBarTime ? new Date(sig.lastBarTime).toISOString() : null}`);
    console.log(`  reason: ${sig.reason}`);
    // 决策表里该 symbol 的时间线
    const decisions = await db.$queryRawUnsafe(
      `SELECT id, action, cycleId, createdAt, detail FROM TrendAutoDecision
       WHERE symbol = ? ORDER BY createdAt DESC LIMIT 8`,
      m.symbol,
    );
    for (const d of decisions.reverse()) {
      console.log(`  决策 ${new Date(d.createdAt).toISOString()} ${d.action} cycle=${String(d.cycleId).slice(0, 30)} id=${String(d.id).slice(0, 40)}`);
    }
    console.log('');
  }
}

main().finally(() => db.$disconnect());
