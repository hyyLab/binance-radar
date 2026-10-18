# -*- coding: utf-8 -*-
"""
Task 73：页面文案「币安」→「binance」（用户要求：算法/注释什么的不要动）

范围 = 只替换「会渲染到页面」的字符串；一律跳过注释行（// /* /** * {/* 开头）：
1. src/app/layout.tsx                 浏览器标签页 title / meta description / keywords
2. src/app/page.tsx                   首页 H1 + 数据来源脚注
3. src/app/trend-trading/page.tsx     趋势交易页 H1
4. src/components/enhanced/enhanced-view.tsx        白名单降级提示 + 品种说明（跳过 2 处注释）
5. src/components/scanner/trade-modal.tsx           源标签 map + 弹窗说明 2 处（跳过 2 处注释）
6. src/components/scanner/paper-panel.tsx           费率说明 + 重置确认文案
7. src/components/market/coin-dialog.tsx            K 线来源说明 2 处（跳过 1 处注释）
8. src/lib/market/futures-feeds.ts                  SOURCE_LABEL['binance'] 值（源健康面板渲染，跳过全部注释）

lib 其余「币安」全部在代码注释里（算法说明），按要求原样保留。
"""
import io
import sys

FILES = [
    'src/app/layout.tsx',
    'src/app/page.tsx',
    'src/app/trend-trading/page.tsx',
    'src/components/enhanced/enhanced-view.tsx',
    'src/components/scanner/trade-modal.tsx',
    'src/components/scanner/paper-panel.tsx',
    'src/components/market/coin-dialog.tsx',
    'src/lib/market/futures-feeds.ts',
]

BASE = '/home/z/my-project/'


def is_comment_line(line: str) -> bool:
    s = line.lstrip()
    return s.startswith('//') or s.startswith('/*') or s.startswith('*') or s.startswith('{/*')


def main() -> None:
    total = 0
    for rel in FILES:
        path = BASE + rel
        with io.open(path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        changed = 0
        for i, line in enumerate(lines):
            if '币安' not in line or is_comment_line(line):
                continue
            lines[i] = line.replace('币安', 'binance')
            changed += line.count('币安')
        with io.open(path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        print(f'[OK] {rel}: {changed} occurrence(s) replaced')
        total += changed
    print(f'[DONE] total {total} replacement(s) across {len(FILES)} files')


if __name__ == '__main__':
    main()
