import { PrismaClient } from '@prisma/client'

// 单例 bump 纪律（Task 53）：schema 新增 TrendWatchSymbol 后，dev 热重载的模块图仍
// 持有旧 client（无新模型，loadActive 会抛错）→ key bump v1→v2。旧实例不 disconnect
//（老模块图仍在用），自然淘汰；后续 schema 变更同样 bump 此 key。
//
// v2→v3（Task 56b）：dev server 进程内的 Prisma SQLite 连接进入永久只读状态
//（attempt to write a readonly database，读正常、写全挂；文件本身经 bun:sqlite 直写
// 可写、磁盘/权限正常）——推断为平台快照替换 db 文件 inode 后，旧连接持有失效 inode。
// bump key 新建 client（新 fd 指向现 inode）恢复写能力；旧 v2 实例不 disconnect，自然淘汰。
//
// v3→v4（Task 78）：同症状第三次（Task 54 一次、Task 70 一次）——平台快照提交 746c2d1
//（db/custom.db mtime 08:42 替换 inode），运行中连接写 1032 readonly、文件层直写 OK。
// 标准路径 bump：新 client 新 fd 指向现 inode；旧 v3 实例自然淘汰。同步 bump 引擎
// 单例 v26→v27（engine/autoTrader 构造时捕获旧 db 引用，必须整体重建）。
const globalForPrisma = globalThis as unknown as {
  __radarPrisma?: PrismaClient // v1：无 TrendWatchSymbol 模型（遗留，不再新建）
  __radarPrisma_v2?: PrismaClient // v2：readonly 连接事件后不再新建（保留读兜底）
  __radarPrisma_v3?: PrismaClient // v3：Task 78 readonly 事件后退役（保留读兜底）
  __radarPrisma_v4?: PrismaClient // v4（Task 78）：现役——快照 746c2d1 替换 inode 后的新连接
  prisma?: PrismaClient // dev 兼容赋值出口（文件尾「旧模块图热重载同样切到新实例」行使用）
}

export const db =
  globalForPrisma.__radarPrisma_v4 ??
  (() => {
    const fresh = new PrismaClient({
      log: ['query'],
    })
    globalForPrisma.__radarPrisma_v4 = fresh
    return fresh
  })()

// 兼容：旧模块图热重载到本文件时同样切到新实例
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
