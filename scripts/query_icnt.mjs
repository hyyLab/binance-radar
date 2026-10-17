import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const d = await db.trendAutoDecision.findFirst({ where: { symbol: 'ICNTUSDT', action: 'OPEN', strategyId: 'major-p1-breakout-v1' }, orderBy: { createdAt: 'desc' } });
console.log('ICNT OPEN 决策完整审计:', JSON.stringify(JSON.parse(d.detail), null, 1));
await db.$disconnect();
