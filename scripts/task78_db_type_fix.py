#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 78 顺手修复：db.ts globalForPrisma 类型声明缺 prisma 兼容属性（存量 tsc 报错，
基线即可复现——兼容赋值行 `globalForPrisma.prisma = db` 加了但类型声明没同步）。"""

import io
import sys

PATH = 'src/lib/db.ts'
with io.open(PATH, encoding='utf-8') as f:
    src = f.read()

old = "  __radarPrisma_v4?: PrismaClient // v4（Task 78）：现役——快照 746c2d1 替换 inode 后的新连接\n}"
new = (
    "  __radarPrisma_v4?: PrismaClient // v4（Task 78）：现役——快照 746c2d1 替换 inode 后的新连接\n"
    "  prisma?: PrismaClient // dev 兼容赋值出口（文件尾「旧模块图热重载同样切到新实例」行使用）\n"
    "}"
)
if src.count(old) != 1:
    print(f'[FAIL] 锚命中 {src.count(old)} 处')
    sys.exit(1)
src = src.replace(old, new)
with io.open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)
print('[OK] globalForPrisma 类型补 prisma 属性')
