// Task 47 诊断：查全部 LIQUIDATE 流水，识别哪些是「强平价≈开仓价」的 bug 误强平
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const liqs = await db.paperTrade.findMany({
  where: { action: 'LIQUIDATE' },
  orderBy: { createdAt: 'desc' },
  take: 30,
});
console.log('=== 全部 LIQUIDATE 流水 ===');
for (const t of liqs) {
  // 找对应仓位拿开仓价
  const pos = t.positionId ? await db.paperPosition.findUnique({ where: { id: t.positionId } }) : null;
  const entry = pos?.entryPrice ?? 0;
  const ratio = entry > 0 ? ((t.price - entry) / entry) * 100 : 0;
  const flag = Math.abs(ratio) < 0.15 ? ' ⚠️ 强平价≈开仓价（bug误强平）' : '';
  console.log(
    `${t.createdAt.toISOString()} ${t.symbol} liq@${t.price} entry@${entry.toFixed(6)} 偏离${ratio.toFixed(2)}% margin=${pos?.margin?.toFixed(2)}${flag}`,
  );
}
await db.$disconnect();
