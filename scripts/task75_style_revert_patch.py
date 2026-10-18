#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Task 75 样式回归（用户反馈前两点）：
# ① 参数控制台弹窗恢复原来的居中位置（去掉移动端底部面板定位，保留行堆叠/大触控等内容优化）
# ② 参数按钮恢复控制区原位第一位（原顺序：参数、算法、持仓、充值、暂停/恢复、全部平仓、重置）；
#    移动端网格重排为：参数(1) 算法(3) / 持仓(2) 充值(1) 重置(1) / 暂停(2) 平仓(2)，无空洞
# ③ 修复桌面端下拉选项弹出列表白底：透明覆盖 select 补回 bg-background text-foreground
#    （Chrome/Edge 原生 options 弹层取 select 自身背景色，bg-transparent 回退白色）

import sys

VIEW = '/home/z/my-project/src/components/trend-trade/trend-trade-view.tsx'
CONSOLE = '/home/z/my-project/src/components/trend-trade/params-console.tsx'

fails = []

def rep(text, old, new, cnt, tag):
    n = text.count(old)
    if n != cnt:
        fails.append(f'[{tag}] 期望 {cnt} 处，实际 {n} 处：{old[:70]!r}')
        return text
    return text.replace(old, new)

# ---------- ① 参数控制台：恢复居中（保留 p-4 sm:p-6 与堆叠行等内容优化） ----------
with open(CONSOLE, 'r', encoding='utf-8') as f:
    pc = f.read()
PC_OLD = '<DialogContent className="max-h-[92dvh] w-[min(680px,calc(100vw-1rem))] gap-3 overflow-y-auto p-4 sm:w-[min(680px,96vw)] sm:gap-4 sm:p-6 max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0">'
PC_NEW = '<DialogContent className="max-h-[88vh] w-[min(680px,96vw)] gap-3 overflow-y-auto p-4 sm:gap-4 sm:p-6">'
if PC_OLD in pc:
    pc = pc.replace(PC_OLD, PC_NEW, 1)
elif PC_NEW not in pc:
    fails.append('[控制台恢复居中] 新旧锚点均未命中')
with open(CONSOLE, 'w', encoding='utf-8') as f:
    f.write(pc)

# ---------- ②/③ 主视图 ----------
with open(VIEW, 'r', encoding='utf-8') as f:
    c = f.read()

# ③ 覆盖 select 弹层配色（算法 + 持仓两处同串）
c = rep(
    c,
    'className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent text-base opacity-0 outline-none"',
    'className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-background text-foreground text-base opacity-0 outline-none"',
    2, '覆盖select弹层配色')

# ②-a 算法 label 移动端 span2→span3（该类名串出现 2 次，第一处 = 算法，只替换第一处）
LBL_OLD = 'className="relative col-span-2 flex h-9 cursor-pointer items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs sm:col-span-1 sm:h-8 sm:text-[11px]"'
LBL_NEW = 'className="relative col-span-3 flex h-9 cursor-pointer items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs sm:col-span-1 sm:h-8 sm:text-[11px]"'
if c.count(LBL_OLD) < 1:
    fails.append('[算法label改span3] 未命中')
else:
    c = c.replace(LBL_OLD, LBL_NEW, 1)

# ②-b 重置按钮移动端 span2→span1（Task 74 拼接为 'col-span-2 ' + 通用类，无 sm:col-span-1）
RESET_OLD = 'className="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-muted-foreground hover:border-gold/50 hover:text-gold disabled:opacity-40 sm:h-8 sm:text-[11px]"'
RESET_NEW = 'className="inline-flex h-9 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-muted-foreground hover:border-gold/50 hover:text-gold disabled:opacity-40 sm:h-8 sm:text-[11px]"'
if c.count(RESET_OLD) != 1:
    fails.append(f'[重置按钮改span1] 命中 {c.count(RESET_OLD)} 处')
else:
    c = c.replace(RESET_OLD, RESET_NEW, 1)

# ②-c DOM 重排：参数按钮块从「持仓之后」移回「算法之前」（当前顺序：算法→持仓→参数→充值）
m_algo = c.find('          {/* Task 57：算法可选')
m_pos = c.find('          {/* Task 55：持仓数量可选')
m_param = c.find('          {/* Task 57-c：参数控制台')
m_dep = c.find('          {/* Task 55：机器人充值')
if not (0 < m_algo < m_pos < m_param < m_dep):
    fails.append(f'[DOM重排] 标记顺序异常 algo={m_algo} pos={m_pos} param={m_param} dep={m_dep}')
else:
    seg_param = c[m_param:m_dep]
    c = c[:m_param] + c[m_dep:]          # 摘除参数块
    c = c[:m_algo] + seg_param + c[m_algo:]  # 插回算法块之前

if fails:
    print('FAIL:\n' + '\n'.join(fails))
    sys.exit(1)

with open(VIEW, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK 样式回归完成：控制台居中恢复 / 参数按钮复位+网格重排 / 弹层配色修复')
