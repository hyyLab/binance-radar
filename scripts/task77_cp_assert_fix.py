#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 77 顺手修复：CP1/CP2 存量断言未跟上 Task 75 的 infra 第4参数 reverseMode。

存量失败（与本任务方向修复无关，基线即可复现）：
- CP1 期望 infra keys 三项 → 实际四项（reverseMode）
- CP2 期望 infra 数量 3 → 实际 4
"""
import io
import sys

PATH = 'tests/trend-trade/strategy-universal-trend.test.ts'

with io.open(PATH, encoding='utf-8') as f:
    src = f.read()

pairs = [
    (
        "  const INFRA = { waitBarConfirm: null, cooldownMs: null, marginRatio: null };",
        "  const INFRA = { waitBarConfirm: null, cooldownMs: null, marginRatio: null, reverseMode: 0 }; // Task 75 起第4项 infra：反向跟随",
        'INFRA 补 reverseMode',
    ),
    (
        "  test('CP1 universal-trend-v1：strategy 域为空（代码默认参数），仅 infra 三项', () => {\n"
        "    const items = effectiveRuntimeParams('universal-trend-v1', null, INFRA);\n"
        "    expect(items.some((p) => p.scope === 'strategy')).toBe(false);\n"
        "    expect(items.map((p) => p.key).sort()).toEqual(['cooldownMs', 'marginRatio', 'waitBarConfirm']);\n"
        "  });",
        "  test('CP1 universal-trend-v1：strategy 域为空（代码默认参数），仅 infra 四项（Task 75 加 reverseMode）', () => {\n"
        "    const items = effectiveRuntimeParams('universal-trend-v1', null, INFRA);\n"
        "    expect(items.some((p) => p.scope === 'strategy')).toBe(false);\n"
        "    expect(items.map((p) => p.key).sort()).toEqual(['cooldownMs', 'marginRatio', 'reverseMode', 'waitBarConfirm']);\n"
        "  });",
        'CP1 断言更新',
    ),
    (
        "  test('CP2 short-swing-v1：13 策略参数（Task 66 新增 ENTRY_CHASE_PCT/ENTRY_FRESH_MS）+ 3 infra', () => {\n"
        "    const items = effectiveRuntimeParams('short-swing-v1', null, INFRA);\n"
        "    expect(items.filter((p) => p.scope === 'strategy').length).toBe(13);\n"
        "    expect(items.filter((p) => p.scope === 'infra').length).toBe(3);",
        "  test('CP2 short-swing-v1：13 策略参数（Task 66 新增 ENTRY_CHASE_PCT/ENTRY_FRESH_MS）+ 4 infra（Task 75 加 reverseMode）', () => {\n"
        "    const items = effectiveRuntimeParams('short-swing-v1', null, INFRA);\n"
        "    expect(items.filter((p) => p.scope === 'strategy').length).toBe(13);\n"
        "    expect(items.filter((p) => p.scope === 'infra').length).toBe(4);",
        'CP2 断言更新',
    ),
]

for old, new, tag in pairs:
    if src.count(old) != 1:
        print(f'[FAIL] {tag}: 锚命中 {src.count(old)} 处'); sys.exit(1)
    src = src.replace(old, new)
    print(f'[OK] {tag}')

with io.open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)
print('CP 断言修复完成')
