#!/usr/bin/env python3
"""Task 70: 行号定位替换 enhanced-view.tsx 的 title 属性（绕开中文字面量不可见漂移）"""
import io

PATH = '/home/z/my-project/src/components/enhanced/enhanced-view.tsx'

with io.open(PATH, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 定位 title 行（ASCII 子串锚定，防漂移）
idx = None
for i, ln in enumerate(lines):
    if 'title={`' in ln and 'homeSymbols' in ln and '${state}' in ln:
        idx = i
        break
assert idx is not None, 'title line not found'

old = lines[idx]
assert '${state}' in old and 'klineReqs' in old, f'unexpected content at line {idx+1}: {old!r}'

# 在 ${state} 后插入降级提示段（与 banHint 同款条件渲染）
new = old.replace('${state} \u00b7', '${state}${degradedHint ? ` \u00b7 ${degradedHint}` : \'\'} \u00b7', 1)
assert new != old, 'replacement produced no change'

lines[idx] = new

with io.open(PATH, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print(f'patched line {idx+1}')
print('OLD:', old.strip()[:120])
print('NEW:', new.strip()[:140])
