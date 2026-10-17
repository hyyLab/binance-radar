#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 71: 趋势页头部/空态「每仓 = 权益 × 20%」硬编码旧文案 → 动态真实公式
真实公式: equity × min(marginRatio, 95%/maxPositions) × riskMultiplier(major-p1 形态 0.5~1.0)
"""
import io, sys

PATH = 'src/components/trend-trade/trend-trade-view.tsx'
src = io.open(PATH, encoding='utf-8').read()
orig = src
fails = []

def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        fails.append(f'[{label}] expect 1 occurrence, got {n}: {old[:60]!r}')
        return
    src = src.replace(old, new, 1)

# ---- Edit 1: 派生变量（effRatioPct / isMajorP1） ----
rep(
    "  const currentStrategy = strategies.find((s) => s.id === strategyId);\n",
    "  const currentStrategy = strategies.find((s) => s.id === strategyId);\n"
    "  // Task 71：单仓比例显示真值化——min(设定比例, 95%÷舱位数)；重大异动突破另乘形态风险倍率 0.5~1.0\n"
    "  const effRatioPct = ((data?.config.effMarginRatio ?? 0.2) * 100).toFixed(3).replace(/\\.?0+$/, '');\n"
    "  const isMajorP1 = strategyId === 'major-p1-breakout-v1';\n",
    'derived-vars',
)

# ---- Edit 2: 头部文案 ----
rep(
    "{currentStrategy?.name ?? strategyId} · 每仓 =\n          开仓时权益 × 20% · {data?.config.leverage ?? 20}x · 无固定止盈止损（按算法规则离场）",
    "{currentStrategy?.name ?? strategyId} · 每仓 =\n          开仓时权益 × {effRatioPct}%{isMajorP1 && '（按入场形态再乘 0.5~1.0 风险倍率）'} · {data?.config.leverage ?? 20}x · 无固定止盈止损（按算法规则离场）",
    'header-text',
)

# ---- Edit 3: 空态文案 ----
rep(
    "暂无自动持仓 · 策略达标后建待入场、下一根收盘 K 线复核开仓（每仓 = 开仓时权益 × 20% +{' '}",
    "暂无自动持仓 · 等待策略触发后按当前算法规则开仓（每仓 = 开仓时权益 × {effRatioPct}%{isMajorP1 && '，另乘形态风险倍率 0.5~1.0'} +{' '}",
    'empty-state-text',
)

if fails:
    print('PATCH FAILED:'); [print(' -', f) for f in fails]; sys.exit(1)
if src == orig:
    print('PATCH FAILED: no change'); sys.exit(1)

io.open(PATH, 'w', encoding='utf-8').write(src)
print('OK: 3 edits applied to', PATH)
