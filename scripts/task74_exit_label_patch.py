#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Task 74 附带：EXIT_REASON_LABEL 补齐新算法退出原因的中文显示映射（纯展示层）

PATH = '/home/z/my-project/src/components/trend-trade/trend-trade-view.tsx'
OLD = """const EXIT_REASON_LABEL: Record<string, string> = {
  TREND_ENDED: '趋势结束',
  REVERSE_CONFIRMED: '反向确认',
  LIQUIDATED: '强平',
  MANUAL: '人工平仓',
};"""
NEW = """const EXIT_REASON_LABEL: Record<string, string> = {
  TREND_ENDED: '趋势结束',
  REVERSE_CONFIRMED: '反向确认',
  LIQUIDATED: '强平',
  MANUAL: '人工平仓',
  // Task 74：策略层个性离场原因的显示映射（短周期套利 / 通用趋势引擎 / 重大异动突破）
  STOP_LOSS: '硬止损',
  SPIKE_TAKE: '冲高落袋',
  TRAIL_TAKE: '移动止盈',
  WEAKNESS_EARLY: '走弱离场',
};"""

with open(PATH, 'r', encoding='utf-8') as f:
    c = f.read()
n = c.count(OLD)
if n != 1:
    print(f'FAIL：EXIT_REASON_LABEL 锚点命中 {n} 处')
    sys.exit(1)
c = c.replace(OLD, NEW)
with open(PATH, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK EXIT_REASON_LABEL 补齐 4 项策略离场显示映射')
