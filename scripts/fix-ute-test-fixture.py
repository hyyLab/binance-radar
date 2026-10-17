#!/usr/bin/env python3
"""Task 62 测试文件修正：verdict 无 lastBarTime（barTime 取自 signal）+ meta fixture 补必填字段。"""
import re

PATH = '/home/z/my-project/tests/trend-trade/strategy-universal-trend.test.ts'
with open(PATH, encoding='utf-8') as f:
    src = f.read()

# --- 块 A（U5a）：sig 先建对象，barTime 从 signal 取 ---
old_a = (
    "    const first = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: cycle }), ctx());\n"
    "    expect(first.want).toBe(true);\n"
    "    s.onOpen('BTCUSDT', cycle, first.lastBarTime ?? bar, Date.now());"
)
new_a = (
    "    const firstSig = sig({ phase: 'CONFIRMED_UP', cycleId: cycle });\n"
    "    const first = s.evaluateEntry(firstSig, ctx());\n"
    "    expect(first.want).toBe(true);\n"
    "    s.onOpen('BTCUSDT', cycle, firstSig.lastBarTime ?? bar, Date.now());"
)
assert old_a in src, '块 A 未匹配'
src = src.replace(old_a, new_a, 1)

# --- 块 B（U5b）：同上 ---
old_b = (
    "    const first = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', cycleId: cycle }), ctx());\n"
    "    expect(first.want).toBe(true);\n"
    "    const entryBar = first.lastBarTime ?? bar;\n"
    "    s.onOpen('BTCUSDT', cycle, entryBar, Date.now());"
)
new_b = (
    "    const firstSig = sig({ phase: 'CONFIRMED_UP', cycleId: cycle });\n"
    "    const first = s.evaluateEntry(firstSig, ctx());\n"
    "    expect(first.want).toBe(true);\n"
    "    const entryBar = firstSig.lastBarTime ?? bar;\n"
    "    s.onOpen('BTCUSDT', cycle, entryBar, Date.now());"
)
assert old_b in src, '块 B 未匹配'
src = src.replace(old_b, new_b, 1)

# --- meta fixture：重写为含全部必填字段的版本（正则锚定 function meta 到 cast 结尾） ---
pattern = re.compile(
    r"function meta\(symbol: string, cycleId: string, side: 'LONG' \| 'SHORT' = 'LONG'\): TrendTradeMetaRow \{.*?\} as TrendTradeMetaRow;\n\}",
    re.S,
)
new_meta = """function meta(symbol: string, cycleId: string, side: 'LONG' | 'SHORT' = 'LONG'): TrendTradeMetaRow {
  return {
    positionId: `pos-${symbol}`,
    trendCycleId: cycleId,
    symbol,
    side,
    trendPhaseAtOpen: 'CONFIRMED_UP',
    scoreAtOpen: 55,
    featuresAtOpen: '{}',
    signalAtOpen: '{}',
    slippageEst: 0.1,
    status: 'OPEN',
    exitReason: null,
    exitSignalJson: null,
    netPnlWithSlip: null,
    openDecisionAt: Date.now() - 120_000,
    closedAt: null,
  } as unknown as TrendTradeMetaRow;
}"""
src, n = pattern.subn(new_meta, src, count=1)
assert n == 1, f'meta fixture 替换数异常：{n}'

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)
print('修正完成：firstSig ×2 + meta fixture 重写')
