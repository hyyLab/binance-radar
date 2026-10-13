// Task 47 诊断：查 ICP 开仓/强平流水 + 账户余额
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const trades = await db.paperTrade.findMany({
  where: { symbol: { contains: 'ICP' } },
  orderBy: { createdAt: 'desc' },
  take: 10,
});
console.log('=== ICP 流水 ===');
for (const t of trades) {
  console.log(JSON.stringify(t, null, 0));
}
const acct = await db.paperAccount.findFirst();
console.log('=== 账户 ===');
console.log(JSON.stringify(acct));
await db.$disconnect();
