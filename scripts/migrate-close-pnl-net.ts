// 一次性迁移：历史平仓流水的 pnl 回补扣除开仓手续费（双边净额口径，与新平仓逻辑一致）
// 背景：旧逻辑平仓行 pnl = 毛盈亏 - 平仓手续费，未扣开仓手续费（开仓费在开仓时已从余额扣除但未体现在流水盈亏中）
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const closeTrades = await db.paperTrade.findMany({
    where: { action: { in: ['CLOSE_LONG', 'CLOSE_SHORT'] }, positionId: { not: null } },
  });
  console.log(`平仓流水 ${closeTrades.length} 条`);

  let patched = 0;
  for (const t of closeTrades) {
    if (!t.positionId) continue;
    const pos = await db.paperPosition.findUnique({ where: { id: t.positionId } });
    if (!pos || pos.openFee <= 0) continue;

    const newTradePnl = t.pnl - pos.openFee;
    await db.paperTrade.update({ where: { id: t.id }, data: { pnl: newTradePnl } });
    console.log(
      `trade ${t.symbol} ${t.action}: pnl ${t.pnl.toFixed(4)} -> ${newTradePnl.toFixed(4)}（扣开仓费 ${pos.openFee.toFixed(4)}）`,
    );

    // 已平仓位的 pnl 同步为净额口径（该字段未在 UI 展示，仅保持数据一致）
    if (pos.status === 'CLOSED') {
      await db.paperPosition.update({
        where: { id: pos.id },
        data: { pnl: pos.pnl - pos.openFee },
      });
    }
    patched += 1;
  }
  console.log(`\n完成：${patched} 条平仓流水已回补开仓手续费`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
