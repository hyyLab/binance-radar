#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Task 74：参数控制台移动端优化（params-console.tsx）
# ① 弹窗：移动端改全宽底部面板（bottom sheet），桌面端保持居中 680px；
#    max-h 用 92dvh 适配移动端地址栏/键盘
# ② 参数行：移动端纵向堆叠（标签说明在上、控件在下），输入框全宽 36px；
#    桌面端保持左右布局 92px 输入框
# ③ 触控目标：「默认」「恢复全部默认」36px、保存按钮移动端全宽 40px
# 纯样式层改动，草稿/保存逻辑零改动。

import sys

PATH = '/home/z/my-project/src/components/trend-trade/params-console.tsx'

with open(PATH, 'r', encoding='utf-8') as f:
    c = f.read()

fails = []

def rep(old, new, cnt=1, tag=''):
    global c
    n = c.count(old)
    if n != cnt:
        fails.append(f'[{tag}] 期望 {cnt} 处，实际 {n} 处：{old[:70]!r}')
        return
    c = c.replace(old, new)

# ---------- ① 弹窗：移动端底部面板 ----------
rep(
    '<DialogContent className="w-[min(680px,96vw)] max-h-[88vh] overflow-y-auto">',
    '<DialogContent className="max-h-[92dvh] w-[min(680px,calc(100vw-1rem))] gap-3 overflow-y-auto p-4 sm:w-[min(680px,96vw)] sm:gap-4 sm:p-6 max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0">',
    1, '弹窗容器')

# ---------- ② 分组卡片 / 无参数提示条 内边距 ----------
rep(
    '<div key={g.group} className="rounded-lg border border-border/60 bg-secondary/10 p-2.5">',
    '<div key={g.group} className="rounded-lg border border-border/60 bg-secondary/10 p-3 sm:p-2.5">',
    1, '分组卡片')
rep(
    '<div className="rounded-lg border border-border/60 bg-secondary/10 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">',
    '<div className="rounded-lg border border-border/60 bg-secondary/10 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground sm:px-2.5 sm:py-2">',
    1, '提示条')

# ---------- ③ 参数行：移动端纵向堆叠 ----------
rep(
    '<div key={p.key} className="flex items-start gap-2.5">',
    '<div key={p.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-2.5">',
    1, '参数行')

# ---------- ④ 数值输入框：移动端全宽 36px / 16px（防 iOS 聚焦缩放） ----------
rep(
    """                            'h-7 w-[92px] text-right font-mono text-[11px] tabular-nums',""",
    """                            'h-9 w-full flex-1 text-right font-mono text-base tabular-nums sm:h-7 sm:w-[92px] sm:flex-none sm:text-[11px]',""",
    1, '数值输入框')

# ---------- ⑤ 默认按钮：36px 触控目标 ----------
rep(
    '"rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:text-gold disabled:opacity-40"',
    '"inline-flex h-9 items-center rounded border border-border px-3 text-[11px] text-muted-foreground hover:text-gold disabled:opacity-40 sm:h-auto sm:px-1 sm:py-0.5 sm:text-[10px]"',
    1, '默认按钮')

# ---------- ⑥ 底部操作区：换行布局 + 全宽保存 ----------
rep(
    '<div className="flex items-center gap-2">\n        <button\n          className="rounded border border-border px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground hover:border-down/50 hover:text-down disabled:opacity-40"',
    '<div className="flex flex-wrap items-center gap-2">\n        <button\n          className="inline-flex h-9 items-center rounded border border-border px-3 text-xs font-semibold text-muted-foreground hover:border-down/50 hover:text-down disabled:opacity-40 sm:h-auto sm:px-2.5 sm:py-1.5 sm:text-[11px]"',
    1, '恢复默认按钮')
rep(
    '"rounded-md bg-gold px-4 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"',
    '"h-10 w-full rounded-md bg-gold text-sm font-bold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:h-auto sm:w-auto sm:px-4 sm:py-1.5 sm:text-xs"',
    1, '保存按钮')

if fails:
    print('FAIL:\n' + '\n'.join(fails))
    sys.exit(1)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK params-console.tsx 全部锚点命中')
