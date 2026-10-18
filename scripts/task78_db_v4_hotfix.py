#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 78: 平台快照替换 db inode → 运行中连接 1032 readonly，按 Task 54 标准路径双 bump 热修复。

现场（第三次同症状，前两次 Task 54/Task 70）：
- 平台快照提交 746c2d1（db/custom.db mtime 08:42 替换 inode）
- 运行中 dev server（05:33 启动）Prisma 连接持有旧 inode → 写 1032 readonly，读正常
- 文件层直写 OK → 文件健康，纯连接失效

修复（改行为必 bump 纪律）：
1. src/lib/db.ts 单例 v3 → v4：新 PrismaClient 新 fd 指向现 inode；旧 v3 实例不 disconnect 自然淘汰
2. src/lib/market/enhanced/engine.ts 单例 v26 → v27：engine/autoTrader/trendWatch 构造时捕获旧 db
   引用，必须整体重建；pickLegacyEngine 链补 v26（stopLegacyEngine 停旧定时器、carryStore
   携带K线仓库、ensureStarted 从 DB 幂等恢复持仓/模式）
"""
import io
import sys

def patch(path, pairs):
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new, tag in pairs:
        n = src.count(old)
        if n != 1:
            print(f'  [FAIL] {tag}: 锚命中 {n} 处 -> {path}')
            sys.exit(1)
        src = src.replace(old, new)
        print(f'  [OK] {tag}')
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)

# ---------- 1) db.ts：单例 v3 → v4 ----------
patch('src/lib/db.ts', [
    (
        """// v2→v3（Task 56b）：dev server 进程内的 Prisma SQLite 连接进入永久只读状态
//（attempt to write a readonly database，读正常、写全挂；文件本身经 bun:sqlite 直写
// 可写、磁盘/权限正常）——推断为平台快照替换 db 文件 inode 后，旧连接持有失效 inode。
// bump key 新建 client（新 fd 指向现 inode）恢复写能力；旧 v2 实例不 disconnect，自然淘汰。""",
        """// v2→v3（Task 56b）：dev server 进程内的 Prisma SQLite 连接进入永久只读状态
//（attempt to write a readonly database，读正常、写全挂；文件本身经 bun:sqlite 直写
// 可写、磁盘/权限正常）——推断为平台快照替换 db 文件 inode 后，旧连接持有失效 inode。
// bump key 新建 client（新 fd 指向现 inode）恢复写能力；旧 v2 实例不 disconnect，自然淘汰。
//
// v3→v4（Task 78）：同症状第三次（Task 54 一次、Task 70 一次）——平台快照提交 746c2d1
//（db/custom.db mtime 08:42 替换 inode），运行中连接写 1032 readonly、文件层直写 OK。
// 标准路径 bump：新 client 新 fd 指向现 inode；旧 v3 实例自然淘汰。同步 bump 引擎
// 单例 v26→v27（engine/autoTrader 构造时捕获旧 db 引用，必须整体重建）。""",
        'db.ts 头部注释补 v4 事件',
    ),
    (
        """const globalForPrisma = globalThis as unknown as {
  __radarPrisma?: PrismaClient // v1：无 TrendWatchSymbol 模型（遗留，不再新建）
  __radarPrisma_v2?: PrismaClient // v2：readonly 连接事件后不再新建（保留读兜底）
  __radarPrisma_v3?: PrismaClient
}

export const db =
  globalForPrisma.__radarPrisma_v3 ??
  (() => {
    const fresh = new PrismaClient({
      log: ['query'],
    })
    globalForPrisma.__radarPrisma_v3 = fresh
    return fresh
  })()""",
        """const globalForPrisma = globalThis as unknown as {
  __radarPrisma?: PrismaClient // v1：无 TrendWatchSymbol 模型（遗留，不再新建）
  __radarPrisma_v2?: PrismaClient // v2：readonly 连接事件后不再新建（保留读兜底）
  __radarPrisma_v3?: PrismaClient // v3：Task 78 readonly 事件后退役（保留读兜底）
  __radarPrisma_v4?: PrismaClient // v4（Task 78）：现役——快照 746c2d1 替换 inode 后的新连接
}

export const db =
  globalForPrisma.__radarPrisma_v4 ??
  (() => {
    const fresh = new PrismaClient({
      log: ['query'],
    })
    globalForPrisma.__radarPrisma_v4 = fresh
    return fresh
  })()""",
        'db.ts 单例 v3→v4',
    ),
])

# ---------- 2) engine.ts：单例 v26 → v27 ----------
patch('src/lib/market/enhanced/engine.ts', [
    (
        """// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v24（Task 73 续）：与采集器 v6 同步 bump——boot() 经 activeFuturesCollector() 动态解析""",
        """// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v27（Task 78）：平台快照 746c2d1 替换 db inode → 运行中连接 1032 readonly（Task 54/70 同
//   症状第三次）——与 db 单例 v3→v4 同步 bump 重建引擎，autoTrader/trendWatch 释放旧 db
//   引用改持新连接；carryStore 携带K线仓库不断供，ensureStarted 从 DB 幂等恢复。
// v24（Task 73 续）：与采集器 v6 同步 bump——boot() 经 activeFuturesCollector() 动态解析""",
        'engine.ts 版本注释加 v27',
    ),
    (
        """  __binanceRadarEnhanced_v26?: EnhancedEngine; // v26（Task 76）：重置清场屏障 + 跳过面板清空 + 换仓数作废待入场
};""",
        """  __binanceRadarEnhanced_v26?: EnhancedEngine; // v26（Task 76）：重置清场屏障 + 跳过面板清空 + 换仓数作废待入场
  __binanceRadarEnhanced_v27?: EnhancedEngine; // v27（Task 78）：db 单例 v4 重建联动——readonly 连接热修复
};""",
        'engine.ts global 声明加 v27',
    ),
    (
        """    __binanceRadarEnhanced_v25?: EnhancedEngine;
    __binanceRadarEnhanced_v26?: EnhancedEngine;
  },
): EnhancedEngine | undefined {
  return (
    g.__binanceRadarEnhanced_v26 ??""",
        """    __binanceRadarEnhanced_v25?: EnhancedEngine;
    __binanceRadarEnhanced_v26?: EnhancedEngine;
    __binanceRadarEnhanced_v27?: EnhancedEngine;
  },
): EnhancedEngine | undefined {
  return (
    g.__binanceRadarEnhanced_v27 ??
    g.__binanceRadarEnhanced_v26 ??""",
        'pickLegacyEngine 链补 v27/v26',
    ),
    (
        """/** 每次读取都取 globalThis 上的当前实例（支持 ?reset=1 热替换，路由不依赖模块级常量） */
export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v26;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v26 = fresh;
  return fresh;
}""",
        """/** 每次读取都取 globalThis 上的当前实例（支持 ?reset=1 热替换，路由不依赖模块级常量） */
export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v27;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v27 = fresh;
  return fresh;
}""",
        'getEnhancedEngine v26→v27',
    ),
    (
        """/** 热重置：停掉旧实例定时器，携带「同市场」K 线仓库创建新实例（应用新代码，不再重复回填） */
export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v26 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v26 = fresh;
  return fresh;
}""",
        """/** 热重置：停掉旧实例定时器，携带「同市场」K 线仓库创建新实例（应用新代码，不再重复回填） */
export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v27 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v27 = fresh;
  return fresh;
}""",
        'resetEnhancedEngine v26→v27',
    ),
])

print('双 bump 补丁完成')
