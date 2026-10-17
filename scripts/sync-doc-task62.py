#!/usr/bin/env python3
"""Task 62：docs/strategy-interface.md 与代码同步（注册案例 / 参数归属过滤 / bump v16）。"""
import re

PATH = '/home/z/my-project/docs/strategy-interface.md'
with open(PATH, encoding='utf-8') as f:
    src = f.read()

# 1) §6.2 注册示例后补真实案例引用
anchor1 = '- **UI 自动出现**：策略下拉与切换确认弹窗读 `listStrategies()`（id/name/description），注册即见，无需改前端。'
assert anchor1 in src, '锚点1 未找到'
add1 = anchor1 + '\n- **真实案例**：`universal-trend-v1`（通用趋势引擎，Task 62）即按本章流程接入——实现 `TrendStrategy` → 注册一行 → 未接控制台参数（代码默认）→ bump v15→v16，全程未重启 server。'
src = src.replace(anchor1, add1, 1)

# 2) §6.3 机制列表追加第 4 条（Task 62 按策略归属过滤）
anchor2 = '3. **热生效链路**：控制台「保存」→ control API 严格校验'
assert anchor2 in src, '锚点2 未找到'
# 找到第 3 条结尾（下一行是 ### 6.4），在其前插入第 4 条
idx = src.find('### 6.4 第四步')
assert idx > 0
item4 = (
    '4. **参数按算法归属过滤（Task 62，多算法时代机制）**：每个 strategy 域 `ParamDef` 标注 `strategyId` 归属，'
    '控制台只展示「属于当前算法」的条目（如 universal-trend-v1 未注册 DEFS → strategy 域为空，仅剩 infra 组，'
    'UI 显示「使用内置默认参数」提示）。校验同样带算法上下文：严格写路径（control API）收到非当前算法的 strategy 键直接 400'
    '（「参数 X 不属于当前算法」）；宽松装配路径（applyStrategy）丢弃跨策略键回退代码默认。'
    'infra 域参数全局共享，不受算法切换影响。\n\n'
)
src = src[:idx] + item4 + src[idx:]

# 3) §6.4 bump 版本表述更新（v15 已成历史，当前 v16）
src = src.replace(
    '以 `globalThis.__binanceRadarEnhanced_v15` 驻留进程',
    '以 `globalThis.__binanceRadarEnhanced_v16` 驻留进程',
    1,
)
src = src.replace(
    'const g = globalThis as typeof globalThis & {\n  // ...v2~v15 声明原样保留...\n  __binanceRadarEnhanced_v16?: EnhancedEngine;           // ① 类型声明加一行',
    'const g = globalThis as typeof globalThis & {\n  // ...v2~v16 声明原样保留...\n  __binanceRadarEnhanced_v17?: EnhancedEngine;           // ① 类型声明加一行',
    1,
)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)

checks = {
    '真实案例引用': src.count('universal-trend-v1`（通用趋势引擎，Task 62）即按本章流程接入'),
    '归属过滤条目': src.count('参数按算法归属过滤（Task 62'),
    'v16 驻留表述': src.count('__binanceRadarEnhanced_v16` 驻留进程'),
}
print('文档同步完成：', checks)
