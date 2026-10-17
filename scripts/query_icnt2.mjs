import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const d = await db.trendAutoDecision.findFirst({ where: { symbol: 'ICNTUSDT', action: 'OPEN' }, orderBy: { createdAt: 'desc' } });
const det = JSON.parse(d.detail);
console.log('ICNT OPEN 决策审计:', JSON.stringify(det, null, 1));
await db.$disconnect();
