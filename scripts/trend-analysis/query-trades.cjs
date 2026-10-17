// 查询最近60条已平仓趋势交易（含持仓明细）
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

async function main() {
  const acc = await db.paperAccount.findUnique({ where: { name: 'trend-auto-v1' } });
  console.log('account:', acc?.id, 'balance:', acc?.balance);
  const metas = await db.$queryRawUnsafe(`
    SELECT * FROM TrendTradeMeta WHERE status='CLOSED' ORDER BY closedAt DESC LIMIT 60
  `);
  console.log('closed trades fetched:', metas.length);
  const earliest = metas[metas.length - 1];
  const latest = metas[0];
  console.log(
    'time range:',
    new Date(earliest.closedAt).toISOString(),
    '->',
    new Date(latest.closedAt).toISOString(),
  );
  const openPos = await db.paperPosition.findMany({ where: { accountId: acc.id, status: 'OPEN' } });
  console.log('open positions:', openPos.length, openPos.map((p) => `${p.symbol}:${p.side}`).join(','));
  const cfg = await db.$queryRawUnsafe(`SELECT * FROM TrendAutoConfig`);
  console.log('config:', JSON.stringify(cfg));

  const fs = require('fs');
  const out = [];
  for (const m of metas) {
    const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
    out.push({
      meta: {
        positionId: m.positionId,
        symbol: m.symbol,
        side: m.side,
        trendCycleId: m.trendCycleId,
        trendPhaseAtOpen: m.trendPhaseAtOpen,
        scoreAtOpen: m.scoreAtOpen,
        featuresAtOpen: m.featuresAtOpen,
        signalAtOpen: m.signalAtOpen,
        slippageEst: m.slippageEst,
        exitReason: m.exitReason,
        exitSignalJson: m.exitSignalJson,
        netPnlWithSlip: m.netPnlWithSlip,
        openDecisionAt: m.openDecisionAt,
        closedAt: m.closedAt,
      },
      pos: pos
        ? {
            symbol: pos.symbol,
            side: pos.side,
            leverage: pos.leverage,
            margin: pos.margin,
            qty: pos.qty,
            entryPrice: pos.entryPrice,
            exitPrice: pos.exitPrice,
            pnl: pos.pnl,
            openFee: pos.openFee,
            closeFee: pos.closeFee,
            status: pos.status,
            openedAt: pos.openedAt,
            closedAt: pos.closedAt,
          }
        : null,
    });
  }
  fs.writeFileSync(
    '/home/z/my-project/scripts/trend-analysis/trades-60.json',
    JSON.stringify(out, null, 1),
  );
  console.log('saved to trades-60.json');
}

main().finally(() => db.$disconnect());
