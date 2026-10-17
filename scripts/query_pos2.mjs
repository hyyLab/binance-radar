import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
console.log('== 自动账户持仓（最近10） ==');
const poses = await db.paperPosition.findMany({ where: { account: { name: 'trend-auto-v1' } }, orderBy: { openedAt: 'desc' }, take: 10 });
for (const p of poses) console.log(`${p.symbol} ${p.side} margin=${p.margin.toFixed(4)} lev=${p.leverage} qty=${p.qty.toFixed(6)} notional=${(p.qty*p.entryPrice).toFixed(2)} status=${p.status} opened=${p.openedAt?.toISOString?.()}`);
console.log('== TrendAutoConfig ==');
const cfgs = await db.trendAutoConfig.findMany();
for (const c of cfgs) console.log(JSON.stringify(c));
await db.$disconnect();
