/**
 * Task 78 实验二：模拟平台快照的真实替换方式——同 inode 内容回写（Task 70 现场证据：
 * db mtime 停在快照时刻 = 文件被原地写过）。验证：
 *   a) 同 inode 回写是否复现 1032 readonly；
 *   b) $disconnect() 惰性重连是否恢复写能力（自愈可行性）。
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const DB = '/home/z/my-project/db/custom.db';
const WRITE = "update TrendAutoConfig set updatedAt=updatedAt where name='trend-auto-v1'";

async function main() {
  const p = new PrismaClient();
  await p.$executeRawUnsafe(WRITE);
  console.log('[1] initial write: OK');

  const mode = await p.$queryRawUnsafe<{ journal_mode?: string }[]>('PRAGMA journal_mode');
  console.log('[1b] journal_mode =', JSON.stringify(mode));

  // 2) 同 inode 内容回写（dd conv=notrunc，inode 不变、内容被覆盖）
  execSync(`cp ${DB} /tmp/db-t78b-copy.db && dd if=/tmp/db-t78b-copy.db of=${DB} conv=notrunc bs=4096 2>/dev/null && rm -f /tmp/db-t78b-copy.db`);
  const inodeAfter = execSync(`ls -i ${DB}`).toString().trim();
  console.log('[2] same-inode rewrite done:', inodeAfter);

  // 3) 旧连接再写 → 平台场景应 1032
  try {
    await p.$executeRawUnsafe(WRITE);
    console.log('[3] write after same-inode rewrite: OK（未复现 1032）');
  } catch (e) {
    console.log('[3] write after same-inode rewrite: FAILED →', String(e).replace(/\s+/g, ' ').slice(0, 110));
  }

  // 4) $disconnect 惰性重连
  await p.$disconnect();
  try {
    await p.$executeRawUnsafe(WRITE);
    console.log('[4] write after $disconnect: OK → 自愈可行');
  } catch (e) {
    console.log('[4] write after $disconnect: FAILED →', String(e).replace(/\s+/g, ' ').slice(0, 110));
  }

  await p.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('experiment error:', e);
    process.exit(1);
  });
