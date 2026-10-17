#!/usr/bin/env python3
"""Task 62：enhanced engine 单例 bump v15 → v16（通用趋势引擎 universal-trend-v1 注册）。

机械规则（与历次 bump 相同）：
1. 读/写点 g.__binanceRadarEnhanced_v15 → v16（getEnhancedEngine / resetEnhancedEngine）
2. globalThis 声明区：v16 声明插入，v15 声明保留（供 pickLegacyEngine 链回收旧实例）
3. pickLegacyEngine：参数类型 + 返回链最前插入 v15
4. 头注释插入 v16 条目
幂等：重复执行无副作用（已含 v16 则跳过）。
"""
import re
import sys

PATH = '/home/z/my-project/src/lib/market/enhanced/engine.ts'
KEY = '__binanceRadarEnhanced_v'

with open(PATH, encoding='utf-8') as f:
    src = f.read()

if f'{KEY}16' in src:
    print('SKIP: v16 已存在（幂等）')
    sys.exit(0)

orig = src

# 1) 读写点升级：v15 → v16（g. 前缀的访问）
src = src.replace(f'g.{KEY}15', f'g.{KEY}16')

# 2) 声明区：v16 声明插入（紧跟 v15 声明之后；v15 保留给 legacy 链）
decl_v15 = f'  {KEY}15?: EnhancedEngine;'
assert decl_v15 in src, 'v15 声明未找到'
src = src.replace(
    decl_v15,
    decl_v15 + f'\n  {KEY}16?: EnhancedEngine; // v16（Task 62）：注册通用趋势引擎 universal-trend-v1',
    1,
)

# 3) pickLegacyEngine：参数类型区 v14 前插 v15 行 + 返回链最前插 v15
param_v15 = f'    {KEY}15?: EnhancedEngine;'
param_v14 = f'    {KEY}14?: EnhancedEngine;'
assert param_v14 in src, 'pickLegacyEngine 参数区 v14 未找到'
src = src.replace(param_v14, param_v15 + '\n' + param_v14, 1)
ret_v14 = f'    g.{KEY}14 ??'
assert ret_v14 in src, '返回链 v14 未找到'
src = src.replace(ret_v14, f'    g.{KEY}15 ??\n' + ret_v14, 1)

# 4) 头注释：v15 条目前插 v16 条目
anchor = '// v15（Task 59）：手续费 0.02% 双边'
assert anchor in src, 'v15 头注释锚点未找到'
v16_note = (
    '// v16（Task 62）：通用趋势引擎算法化——最开始的 Universal Trend Engine（vendor 包，\n'
    '//   系统唯一趋势信号源）整理为可插拔算法 universal-trend-v1 注册进 STRATEGY_FACTORIES\n'
    '//   （确认即顺势 / 无评分·ER·5m 门槛 / 走弱先走 ≤2 轮；默认算法仍 short-swing-v1 不变，\n'
    '//   切换走 UI 下拉）。console-params 参数按策略归属过滤（ParamDef.strategyId）。\n'
    '//   改行为必 bump key；旧实例 stop() 会同步停掉 autoTrader 主循环，新实例从 DB 恢复\n'
    '//   持仓关联（reconcile）与策略轮次状态（TrendStrategyState 按 strategyId 存取）。\n'
)
src = src.replace(anchor, v16_note + anchor, 1)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)

# 校验摘要
checks = {
    '读写点 v16': src.count(f'g.{KEY}16'),
    '声明区 v15 保留': src.count(f'  {KEY}15?: EnhancedEngine;'),
    '声明区 v16 新增': src.count(f'  {KEY}16?: EnhancedEngine;'),
    '返回链 v15': src.count(f'    g.{KEY}15 ??'),
    '残留读写点 v15（应为 0）': src.count(f'g.{KEY}15 ='),
}
print('bump 完成：', checks)
print('与原文差异行数：', sum(1 for a, b in zip(orig.splitlines(), src.splitlines()) if a != b))
