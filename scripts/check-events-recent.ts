import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const BJ = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
async function main() {
  const total = await db.anomalyEvent.count();
  const latest = await db.anomalyEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 15 });
  console.log(`=== AnomalyEvent 总数 ${total}，最新 15 条 ===`);
  for (const e of latest) {
    console.log(`${BJ(e.createdAt)} ${e.symbol} ${e.type} ${e.severity}`);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
