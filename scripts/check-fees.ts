// 查询模拟盘流水与手续费记录（核对买入/卖出手续费是否都收了）
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const byAction = await db.paperTrade.groupBy({
    by: ['action'],
    _count: { _all: true },
    _sum: { fee: true, pnl: true },
  });
  console.log('=== 按动作汇总 ===');
  for (const r of byAction) {
    console.log(
      `${r.action}: ${r._count._all} 条 · fee合计 ${(r._sum.fee ?? 0).toFixed(4)} · pnl合计 ${(r._sum.pnl ?? 0).toFixed(4)}`,
    );
  }

  const trades = await db.paperTrade.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('\n=== 最近 10 条流水 ===');
  for (const t of trades) {
    console.log(
      `${t.action} ${t.symbol} price=${t.price} qty=${t.qty} fee=${t.fee.toFixed(4)} pnl=${t.pnl.toFixed(4)} pos=${t.positionId ?? '-'}`,
    );
  }

  const acc = await db.paperAccount.findUnique({ where: { name: 'default' } });
  console.log('\n=== 账户 ===');
  console.log(
    `balance=${acc?.balance.toFixed(4)} totalDeposited=${acc?.totalDeposited}`,
  );

  const open = await db.paperPosition.findMany({ where: { status: 'OPEN' } });
  console.log(`\n=== 当前持仓 ${open.length} 个 ===`);
  for (const p of open) {
    console.log(
      `${p.symbol} ${p.side} margin=${p.margin.toFixed(2)} lev=${p.leverage} openFee=${p.openFee.toFixed(4)}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
