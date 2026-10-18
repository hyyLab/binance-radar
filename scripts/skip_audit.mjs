import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const fmt = (d) => new Date(d).toISOString().slice(11,19);
// major-p1 是 18:17 左右启用的；SKIP 决策行按时间分布
const rows = await db.trendAutoDecision.findMany({ where: { detail: { contains: 'SKIP' } }, orderBy: { createdAt: 'desc' }, take: 40 });
const byHour = {};
for (const r of rows) { const h = fmt(r.createdAt).slice(0,2); byHour[h] = (byHour[h]||0)+1; }
console.log('DB SKIP 决策行按小时分布:', JSON.stringify(byHour));
console.log('最近 6 条 SKIP:');
for (const r of rows.slice(0,6)) console.log(fmt(r.createdAt), r.symbol.padEnd(10), JSON.parse(r.detail).reason?.slice(0,60));
await db.$disconnect();
