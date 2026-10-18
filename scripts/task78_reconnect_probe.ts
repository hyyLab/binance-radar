/**
 * Task 78 实验：验证 Prisma SQLite 连接在 db 文件 inode 被替换后，
 * $disconnect() 惰性重连能否恢复写能力（自愈机制可行性）。
 *
 * 模拟平台快照：cp 到临时文件再 mv 回原路径（同路径、新 inode、内容一致、原子）。
 * ⚠️ 实验期间运行中的 dev server 连接本就处于 readonly 坏状态，不会更糟；
 *    mv 原子替换且内容与原文件一致，风险可控。
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const DB = '/home/z/my-project/db/custom.db';
const WRITE = "update TrendAutoConfig set updatedAt=updatedAt where name='trend-auto-v1'";

async function main() {
  const p = new PrismaClient();
  // 1) 初始写（新 client 直指当前 inode，应成功）
  await p.$executeRawUnsafe(WRITE);
  console.log('[1] initial write: OK');

  // 2) 模拟快照替换 inode
  execSync(`cp ${DB} /tmp/db-t78-sim.db && mv /tmp/db-t78-sim.db ${DB}`);
  console.log('[2] inode swapped (cp+mv, same content)');

  // 3) 旧连接再写 → 期待 1032 readonly
  try {
    await p.$executeRawUnsafe(WRITE);
    console.log('[3] write after swap: OK（意外——假设不成立或不复现）');
  } catch (e) {
    console.log('[3] write after swap: FAILED as expected →', String(e).replace(/\s+/g, ' ').slice(0, 100));
  }

  // 4) $disconnect 后再写 → 假设：惰性重连打开新 inode
  await p.$disconnect();
  try {
    await p.$executeRawUnsafe(WRITE);
    console.log('[4] write after $disconnect: OK → 自愈机制可行（disconnect 触发惰性重连新 inode）');
  } catch (e) {
    console.log('[4] write after $disconnect: FAILED →', String(e).replace(/\s+/g, ' ').slice(0, 100));
    console.log('    结论：disconnect 不触发重开文件，需换 client 实例');
  }

  await p.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('experiment error:', e);
    process.exit(1);
  });
