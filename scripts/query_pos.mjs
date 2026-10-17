import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const accs = await db.paperAccount.findMany();
console.log('== 账户 ==');
for (const a of accs) console.log(JSON.stringify(a));
const tables = await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type='table'`);
console.log('== 表 ==', tables.map(t=>t.name).join(', '));
await db.$disconnect();
