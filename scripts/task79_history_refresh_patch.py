#!/usr/bin/env python3
# Task 79：自动平仓历史可见延迟优化——use-trend-trade.ts 事件驱动失效历史缓存
# 三处锚定替换：①react imports ②文件头注释补说明 ③useTrendTradeHistory 加 closedCount 监听
import io, sys

PATH = '/home/z/my-project/src/hooks/use-trend-trade.ts'
src = io.open(PATH, encoding='utf-8').read()

edits = [
    # ① imports：补 useEffect/useRef
    (
        "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
        "import { useEffect, useRef } from 'react';\n"
        "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
    ),
    # ② 文件头注释：补 Task 79 说明
    (
        "// 总览 5s 轮询（持仓/账户/模式）；历史 20s 轮询（筛选条件变化即刷新）。",
        "// 总览 5s 轮询（持仓/账户/模式）；历史 20s 轮询（筛选条件变化即刷新）。\n"
        "// Task 79：自动平仓（趋势结束/反向/策略离场/强平）不经前端 mutation，历史原本\n"
        "// 只能等自身 20s 轮询才发现变化——用户看到「仓位已消失、历史迟迟不出现」。\n"
        "// 现在监听总览 stats.closedCount（与历史行数同源的计数，5s 轮询内必变），\n"
        "// 一变立即失效历史缓存：自动平仓可见延迟 ~20s → ~5s，与手动平仓体验一致。",
    ),
    # ③ useTrendTradeHistory：加 closedCount 监听
    (
        "export function useTrendTradeHistory(symbol: string, sort: string, order: string) {\n"
        "  return useQuery({\n"
        "    queryKey: ['trend-trading-history', symbol, sort, order],",
        "export function useTrendTradeHistory(symbol: string, sort: string, order: string) {\n"
        "  const queryClient = useQueryClient();\n"
        "  // Task 79：closedCount 变化 ⇒ 历史行集合必变（同源计数）⇒ 立即失效历史缓存。\n"
        "  // 首次观测不触发（挂载时查询本就会拉取）；重置清场使计数下降时同样触发。\n"
        "  const closedCount = useTrendTrading().data?.stats.closedCount;\n"
        "  const lastClosedCountRef = useRef<number | null>(null);\n"
        "  useEffect(() => {\n"
        "    if (closedCount == null) return;\n"
        "    const last = lastClosedCountRef.current;\n"
        "    lastClosedCountRef.current = closedCount;\n"
        "    if (last !== null && last !== closedCount) {\n"
        "      void queryClient.invalidateQueries({ queryKey: ['trend-trading-history'] });\n"
        "    }\n"
        "  }, [closedCount, queryClient]);\n"
        "\n"
        "  return useQuery({\n"
        "    queryKey: ['trend-trading-history', symbol, sort, order],",
    ),
]

for i, (old, new) in enumerate(edits, 1):
    n = src.count(old)
    if n != 1:
        print(f'FAIL: anchor {i} count={n} (expect 1)')
        sys.exit(1)
    src = src.replace(old, new)
    print(f'anchor {i} replaced OK')

io.open(PATH, 'w', encoding='utf-8').write(src)
print('patched:', PATH)
