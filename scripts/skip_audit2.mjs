import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const fmt = (d) => new Date(d).toISOString().slice(11,19);
const rows = await db.trendAutoDecision.findMany({ where: { action: 'SKIP' }, orderBy: { createdAt: 'desc' }, take: 60 });
const byHour = {};
for (const r of rows) { const h = fmt(r.createdAt).slice(0,2); byHour[h] = (byHour[h]||0)+1; }
console.log(`DB SKIP 决策行共取 ${rows.length} 条，按小时(UTC)分布:`, JSON.stringify(byHour));
for (const r of rows.slice(0,8)) console.log(fmt(r.createdAt), r.symbol.padEnd(10), JSON.parse(r.detail).reason?.slice(0,70));
await db.$disconnect();
