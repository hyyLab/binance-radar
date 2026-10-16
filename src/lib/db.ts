import { PrismaClient } from '@prisma/client'

// 单例 bump 纪律（Task 53）：schema 新增 TrendWatchSymbol 后，dev 热重载的模块图仍
// 持有旧 client（无新模型，loadActive 会抛错）→ key bump v1→v2。旧实例不 disconnect
//（老模块图仍在用），自然淘汰；后续 schema 变更同样 bump 此 key。
const globalForPrisma = globalThis as unknown as {
  __radarPrisma?: PrismaClient // v1：无 TrendWatchSymbol 模型（遗留，不再新建）
  __radarPrisma_v2?: PrismaClient
}

export const db =
  globalForPrisma.__radarPrisma_v2 ??
  (() => {
    const fresh = new PrismaClient({
      log: ['query'],
    })
    globalForPrisma.__radarPrisma_v2 = fresh
    return fresh
  })()

// 兼容：旧模块图热重载到本文件时同样切到新实例
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
