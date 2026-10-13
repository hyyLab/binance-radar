// Task 47 迁移：修复「强平价退化到开仓价」bug 造成的误强平
// 1) ICP 空仓恢复 OPEN：删除 LIQUIDATE 流水、退回被吞的保证金、按修复后公式重算强平价
// 2) 全部存量 OPEN 仓位：按新 MMR 档位 + 钳制公式重算 liqPrice
import { PrismaClient } from '@prisma/client';
import { liqPriceFor } from '../src/lib/market/futures';

const db = new PrismaClient();

// ---- 1. 恢复 ICP 误强平仓位 ----
const icpLiq = await db.paperTrade.findFirst({
  where: { action: 'LIQUIDATE', symbol: 'ICPUSDT' },
  orderBy: { createdAt: 'desc' },
});
if (!icpLiq || !icpLiq.positionId) {
  console.log('未找到 ICP LIQUIDATE 流水，跳过恢复');
} else {
  const pos = await db.paperPosition.findUnique({ where: { id: icpLiq.positionId } });
  if (!pos) {
    console.log('ICP 仓位不存在，跳过');
  } else if (pos.status !== 'LIQUIDATED') {
    console.log(`ICP 仓位状态为 ${pos.status}（已处理过），跳过`);
  } else {
    const newLiq = liqPriceFor({
      symbol: pos.symbol,
      side: pos.side as 'LONG' | 'SHORT',
      entry: pos.entryPrice,
      leverage: pos.leverage,
      notional: pos.margin * pos.leverage,
    });
    await db.$transaction([
      db.paperTrade.delete({ where: { id: icpLiq.id } }), // 删除误强平流水
      db.paperPosition.update({
        where: { id: pos.id },
        data: { status: 'OPEN', exitPrice: null, pnl: 0, closedAt: null, liqPrice: newLiq },
      }),
      db.paperAccount.update({
        where: { id: pos.accountId },
        data: { balance: { increment: pos.margin } }, // 退回被强平吞掉的保证金
      }),
    ]);
    console.log(
      `ICP 仓位已恢复 OPEN：entry=${pos.entryPrice} margin=${pos.margin} 新强平价=${newLiq.toFixed(6)}（旧=${pos.liqPrice}） 保证金已退回`,
    );
  }
}

// ---- 2. 重算全部存量 OPEN 仓位强平价 ----
const open = await db.paperPosition.findMany({ where: { status: 'OPEN' } });
for (const p of open) {
  const newLiq = liqPriceFor({
    symbol: p.symbol,
    side: p.side as 'LONG' | 'SHORT',
    entry: p.entryPrice,
    leverage: p.leverage,
    notional: p.margin * p.leverage,
  });
  if (Math.abs(newLiq - p.liqPrice) / p.liqPrice < 1e-9) continue; // 无变化
  await db.paperPosition.update({ where: { id: p.id }, data: { liqPrice: newLiq } });
  console.log(`${p.symbol} ${p.side} liq: ${p.liqPrice.toFixed(6)} → ${newLiq.toFixed(6)}`);
}

const acc = await db.paperAccount.findFirst();
console.log(`\n账户余额现为: ${acc?.balance.toFixed(4)}`);
await db.$disconnect();
