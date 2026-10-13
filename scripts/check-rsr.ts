import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const BJ = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

async function main() {
  // 11:20-11:45 北京 = 03:20-03:45 UTC 的事件
  const from = new Date('2026-10-13T03:20:00Z');
  const to = new Date('2026-10-13T03:45:00Z');
  const evs = await db.anomalyEvent.findMany({
    where: { createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`=== ${BJ(from)} ~ ${BJ(to)} 北京 事件 ${evs.length} 条 ===`);
  for (const e of evs.slice(0, 30)) {
    console.log(`${BJ(e.createdAt)} ${e.symbol} ${e.type} ${e.severity} chg=${e.changePct?.toFixed(2)}% vm=${e.volumeMultiple?.toFixed(1) ?? '-'} qv1m=${e.quoteVolume1m?.toFixed(0) ?? '-'}`);
  }
  const rsr = await db.anomalyEvent.findMany({
    where: { symbol: { contains: 'RSR' } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log(`\n=== RSR 历史事件 ${rsr.length} 条（最近） ===`);
  for (const e of rsr) {
    console.log(`${BJ(e.createdAt)} ${e.symbol} ${e.type} ${e.severity} chg=${e.changePct?.toFixed(2)}% vm=${e.volumeMultiple?.toFixed(1) ?? '-'} qv1m=${e.quoteVolume1m?.toFixed(0) ?? '-'}`);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
