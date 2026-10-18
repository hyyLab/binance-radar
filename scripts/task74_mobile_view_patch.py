#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Task 74：趋势自动模拟交易页移动端体验优化（主视图 + 页面壳）
# ① 头部控制区：移动端 3 行网格（算法/持仓 span2 + 参数/充值/暂停span2 + 平仓/重置 span2），
#    按钮 36px 触控目标；桌面端保持单行 flex（ml-auto）
# ② 算法/持仓下拉：透明原生 select 覆盖整块 label（整块可点，16px 防 iOS 聚焦缩放），
#    可见层显示当前值 + ChevronDown
# ③ 头部账户摘要：移动端不再隐藏（原 hidden sm:inline 手机端完全不可见）
# ④ 历史明细：移动端两行紧凑卡片，桌面端保持 8 列表格行；筛选控件增大
# ⑤ 持仓卡 K线/平仓按钮 28px 触控目标；充值/确认弹窗宽度改 calc(100vw-1rem)
# 算法逻辑零改动——纯 className/结构样式层补丁。

import sys

PATH = '/home/z/my-project/src/components/trend-trade/trend-trade-view.tsx'
PAGE = '/home/z/my-project/src/app/trend-trading/page.tsx'

with open(PATH, 'r', encoding='utf-8') as f:
    c = f.read()

orig = c
fails = []

def rep(old, new, cnt=1, tag=''):
    global c
    n = c.count(old)
    if n != cnt:
        fails.append(f'[{tag}] 期望 {cnt} 处，实际 {n} 处：{old[:70]!r}')
        return
    c = c.replace(old, new)

# ---------- ① headerInfo 变量：移动端可见的账户/算法摘要 ----------
rep(
    """  return (
    <div className="space-y-3">
      {/* 头部：标题 + 模式 + 控制 */}
""",
    """  // Task 74：头部账户/算法摘要——桌面单行内联，移动端独立成行（原来手机端完全不可见）
  const headerInfo = (
    <>
      账户 {data?.config.accountName ?? 'trend-auto-v1'} · 初始 {data?.config.initialCapital ?? '—'} USDT
      {totalDeposited > 0 && <span className="text-gold"> · 累计充值 +{totalDeposited.toFixed(0)}</span>} · 算法
      {currentStrategy?.name ?? strategyId} · 每仓 =
      开仓时权益 × {effRatioPct}%{isMajorP1 && '（按入场形态再乘 0.5~1.0 风险倍率）'} · {data?.config.leverage ?? 20}x · 无固定止盈止损（按算法规则离场）
    </>
  );

  return (
    <div className="space-y-3">
      {/* 头部：标题 + 模式 + 控制（Task 74：移动端控制区 3 行网格 + 36px 触控目标） */}
""",
    1, 'headerInfo插入')

rep(
    """        <span className="hidden text-[10px] text-muted-foreground sm:inline">
          账户 {data?.config.accountName ?? 'trend-auto-v1'} · 初始 {data?.config.initialCapital ?? '—'} USDT
          {totalDeposited > 0 && <span className="text-gold"> · 累计充值 +{totalDeposited.toFixed(0)}</span>} · 算法
          {currentStrategy?.name ?? strategyId} · 每仓 =
          开仓时权益 × {effRatioPct}%{isMajorP1 && '（按入场形态再乘 0.5~1.0 风险倍率）'} · {data?.config.leverage ?? 20}x · 无固定止盈止损（按算法规则离场）
        </span>
""",
    """        <span className="hidden text-[10px] text-muted-foreground sm:inline">{headerInfo}</span>
        <div className="w-full text-[10px] leading-relaxed text-muted-foreground sm:hidden">{headerInfo}</div>
""",
    1, 'headerInfo渲染')

# ---------- ② 控制区容器：移动端网格 ----------
rep(
    '<div className="ml-auto flex items-center gap-1.5">',
    '<div className="grid w-full grid-cols-4 gap-1.5 sm:ml-auto sm:flex sm:w-auto sm:items-center sm:gap-1.5">',
    1, '控制区容器')

# ---------- ③ 分段重排：算法/持仓前置，参数/充值后置（网格自动布局 3 行无空洞） ----------
m_a = c.find('          {/* Task 57-c：参数控制台')
m_b = c.find('          {/* Task 57：算法可选')
m_c = c.find('          {/* Task 55：持仓数量可选')
m_d = c.find('          {/* Task 55：机器人充值')
m_e = c.find("          {mode === 'RUNNING' ? (")
m_f = c.find('          {/* Task 55-2：重置机器人账户')
for name, idx in [('A参数', m_a), ('B算法', m_b), ('C持仓', m_c), ('D充值', m_d), ('E暂停', m_e), ('F重置', m_f)]:
    if idx < 0:
        fails.append(f'[分段] 未找到标记 {name}')
if not fails:
    seg_end = c.find('\n        </div>\n      </div>', m_f)
    if seg_end < 0:
        fails.append('[分段] 未找到控制区结束 </div>')
if not fails:
    seg_end += len('\n        </div>')
    seg_a, seg_b = c[m_a:m_b], c[m_b:m_c]
    seg_c, seg_d = c[m_c:m_d], c[m_d:m_e]
    seg_e, seg_f = c[m_e:m_f], c[m_f:seg_end]
    post = c[seg_end:]

    # 算法下拉 → 整块触控 label + 透明原生 select 覆盖
    seg_b = """          {/* Task 57：算法可选——更换即自动平仓原有持仓，新算法接管后续开仓（Task 74：整块触控 + 原生选择器，16px 防 iOS 聚焦缩放） */}
          <label
            className="relative col-span-2 flex h-9 cursor-pointer items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs sm:col-span-1 sm:h-8 sm:text-[11px]"
            title={currentStrategy?.description ?? '交易算法（可插拔策略；更换会自动平仓原有持仓）'}
          >
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">算法 </span>
              <span className="font-semibold text-foreground">{currentStrategy?.name ?? strategyId}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <select
              value={strategyId}
              disabled={busy}
              onChange={(e) => changeStrategy(e.target.value)}
              aria-label="交易算法"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent text-base opacity-0 outline-none"
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
"""
    # 持仓下拉 → 同上
    seg_c = """          {/* Task 55：持仓数量可选——更换即自动平仓原有持仓（Task 74：整块触控） */}
          <label
            className="relative col-span-2 flex h-9 cursor-pointer items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs sm:col-span-1 sm:h-8 sm:text-[11px]"
            title="最大同时持仓数；更换数量会自动平仓原有持仓。每仓保证金 = 开仓时权益 × min(设定比例, 95%÷配置舱位数)——选 1 舱单仓满配 95%，选 N 舱各 95%/N，先开仓不挤占后舱；余额不足时跳过并记录。比例可在参数控制台调整"
          >
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">持仓 </span>
              <span className="font-semibold text-foreground">{maxPositions} 仓</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <select
              value={maxPositions}
              disabled={busy}
              onChange={(e) => changePositions(Number(e.target.value))}
              aria-label="最大同时持仓数"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent text-base opacity-0 outline-none"
            >
              {POSITION_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} 仓
                </option>
              ))}
            </select>
          </label>
"""
    btn_common_new = 'inline-flex h-9 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-muted-foreground hover:border-gold/50 hover:text-gold disabled:opacity-40 sm:h-8 sm:text-[11px]'
    btn_old_border = 'inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:border-gold/50 hover:text-gold disabled:opacity-40'
    # 参数按钮（seg_a 内）
    if btn_old_border not in seg_a:
        fails.append('[参数按钮] 类名未命中')
    else:
        seg_a = seg_a.replace(btn_old_border, btn_common_new)
        seg_a = seg_a.replace('className="h-3 w-3"', 'className="h-3.5 w-3.5 sm:h-3 sm:w-3"')
    # 充值按钮（seg_d 内）
    dep_old = 'inline-flex items-center gap-1 rounded border border-gold/50 bg-gold/10 px-2 py-1 text-[11px] font-bold text-gold hover:bg-gold/20 disabled:opacity-40'
    dep_new = 'inline-flex h-9 items-center justify-center gap-1 rounded-md border border-gold/50 bg-gold/10 px-2 text-xs font-bold text-gold hover:bg-gold/20 disabled:opacity-40 sm:h-8 sm:text-[11px]'
    if dep_old not in seg_d:
        fails.append('[充值按钮] 类名未命中')
    else:
        seg_d = seg_d.replace(dep_old, dep_new)
        seg_d = seg_d.replace('className="h-3 w-3"', 'className="h-3.5 w-3.5 sm:h-3 sm:w-3"')
    # 暂停/恢复/全部平仓（seg_e 内，移动端 span2）
    pause_old = 'inline-flex items-center gap-1 rounded border border-gold/50 px-2 py-1 text-[11px] font-semibold text-gold hover:bg-gold/10 disabled:opacity-40'
    pause_new = 'col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-gold/50 px-2 text-xs font-semibold text-gold hover:bg-gold/10 disabled:opacity-40 sm:col-span-1 sm:h-8 sm:text-[11px]'
    resume_old = 'inline-flex items-center gap-1 rounded border border-up/50 px-2 py-1 text-[11px] font-semibold text-up hover:bg-up/10 disabled:opacity-40'
    resume_new = 'col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-up/50 px-2 text-xs font-semibold text-up hover:bg-up/10 disabled:opacity-40 sm:col-span-1 sm:h-8 sm:text-[11px]'
    close_old = 'inline-flex items-center gap-1 rounded border border-down/50 px-2 py-1 text-[11px] font-semibold text-down hover:bg-down/10 disabled:opacity-40'
    close_new = 'col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-md border border-down/50 px-2 text-xs font-semibold text-down hover:bg-down/10 disabled:opacity-40 sm:col-span-1 sm:h-8 sm:text-[11px]'
    for tag, o, n in [('暂停按钮', pause_old, pause_new), ('恢复按钮', resume_old, resume_new), ('平仓按钮', close_old, close_new)]:
        if o not in seg_e:
            fails.append(f'[{tag}] 类名未命中')
        else:
            seg_e = seg_e.replace(o, n)
    seg_e = seg_e.replace('className="h-3 w-3"', 'className="h-3.5 w-3.5 sm:h-3 sm:w-3"')
    # 重置按钮（seg_f 内，移动端 span2）
    if btn_old_border not in seg_f:
        fails.append('[重置按钮] 类名未命中')
    else:
        seg_f = seg_f.replace(btn_old_border, 'col-span-2 ' + btn_common_new)
        seg_f = seg_f.replace('className="h-3 w-3"', 'className="h-3.5 w-3.5 sm:h-3 sm:w-3"')

    # 重排拼接：算法 持仓 参数 充值 暂停/恢复 平仓 重置
    c = c[:m_a] + seg_b + seg_c + seg_a + seg_d + seg_e + seg_f + post

# ---------- ④ 持仓卡：顶行可换行 + K线/平仓按钮触控目标 ----------
rep(
    """      title="点击查看该币种 K 线（含持仓成本线 / 强平线 / 开仓时点标记）"
    >
      <div className="flex items-center gap-1.5">
""",
    """      title="点击查看该币种 K 线（含持仓成本线 / 强平线 / 开仓时点标记）"
    >
      <div className="flex flex-wrap items-center gap-1.5">
""",
    1, '持仓卡顶行')
rep(
    '"rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-gold disabled:opacity-40"',
    '"inline-flex h-7 items-center rounded border border-border px-2 text-[11px] text-muted-foreground hover:text-gold disabled:opacity-40"',
    1, 'K线按钮')
rep(
    '"rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-down disabled:opacity-40"',
    '"inline-flex h-7 items-center rounded border border-border px-2 text-[11px] text-muted-foreground hover:text-down disabled:opacity-40"',
    1, '平仓按钮')

# ---------- ⑤ 历史明细：移动端两行紧凑卡片，桌面端保持表格行 ----------
s = c.find('  return (\n    <button\n      onClick={() => onDetail(t.positionId)}')
e = c.find('/** 历史明细表头')
if s < 0 or e < 0 or e <= s:
    fails.append('[TradeRow] 边界定位失败')
else:
    trade_row_new = """  return (
    <button
      onClick={() => onDetail(t.positionId)}
      className="w-full rounded px-2 py-2 text-left text-[11px] tabular-nums hover:bg-secondary/40 sm:grid sm:grid-cols-[92px_92px_60px_44px_1fr_1fr_64px_88px] sm:items-center sm:gap-1 sm:px-2 sm:py-1"
      title="点击查看开仓依据与趋势变化详情；点击币种可看 K 线"
    >
      {/* Task 74：移动端两行紧凑卡片（桌面端保持 8 列表格行） */}
      <span className="flex items-center gap-1.5 sm:hidden">
        <span className={cn('shrink-0 font-bold', t.side === 'LONG' ? 'text-up' : 'text-down')}>
          {t.side === 'LONG' ? '多' : '空'}
        </span>
        <span
          className="cursor-pointer font-mono font-semibold hover:text-gold"
          onClick={(e) => {
            e.stopPropagation();
            onKline(t);
          }}
          title={`点击查看 ${t.symbol} K 线（含开/平仓价线与时点标记）`}
        >
          {t.base}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {fmtPrice(t.entryPrice)} → {t.exitPrice != null ? fmtPrice(t.exitPrice) : '—'}
        </span>
        <span className={cn('ml-auto shrink-0 font-bold', pnlClass(net))}>
          {net != null ? net.toFixed(3) : '—'}
        </span>
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground sm:hidden">
        <span className="shrink-0">{fmtStamp(t.openedAt)}</span>
        <span
          className="min-w-0 truncate"
          title={`算法：${t.strategyName ?? t.strategyId ?? '—'}（费用/滑点累计口径见顶部统计卡）`}
        >
          {t.strategyName ?? t.strategyId ?? '—'}
        </span>
        <span className={cn('ml-auto shrink-0 font-semibold', exitLabel === '强平' ? 'text-down' : '')}>
          {exitLabel}
        </span>
      </span>
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={`开仓 ${new Date(t.openedAt).toLocaleString('zh-CN')} → 持仓 ${t.holdMinutes ?? '—'} 分钟`}
      >
        {fmtStamp(t.openedAt)}
      </span>
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={t.closedAt ? `平仓 ${new Date(t.closedAt).toLocaleString('zh-CN')} · 持仓 ${t.holdMinutes ?? '—'} 分钟` : ''}
      >
        {fmtStamp(t.closedAt)}
      </span>
      <span
        className="hidden cursor-pointer truncate font-mono font-semibold hover:text-gold sm:block"
        onClick={(e) => {
          e.stopPropagation();
          onKline(t);
        }}
        title={`点击查看 ${t.symbol} K 线（含开/平仓价线与时点标记）`}
      >
        {t.base}
      </span>
      <span className={cn('hidden font-bold sm:block', t.side === 'LONG' ? 'text-up' : 'text-down')}>
        {t.side === 'LONG' ? '多' : '空'}
      </span>
      <span className="hidden truncate text-muted-foreground sm:block">
        {fmtPrice(t.entryPrice)} → {t.exitPrice != null ? fmtPrice(t.exitPrice) : '—'}
      </span>
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={`算法：${t.strategyName ?? t.strategyId ?? '—'}（费用/滑点不再逐行展示，累计口径见顶部统计卡）`}
      >
        {t.strategyName ?? t.strategyId ?? '—'}
      </span>
      <span className={cn('hidden truncate font-semibold sm:block', exitLabel === '强平' ? 'text-down' : 'text-muted-foreground')}>
        {exitLabel}
      </span>
      <span className={cn('hidden text-right font-bold sm:block', pnlClass(net))}>
        {net != null ? net.toFixed(3) : '—'}
      </span>
    </button>
  );
}

"""
    c = c[:s] + trade_row_new + c[e:]

rep(
    '<div className="grid grid-cols-[76px_76px_48px_40px_1fr_1fr_54px_76px] gap-1 px-2 text-[10px] text-muted-foreground/70 sm:grid-cols-[92px_92px_60px_44px_1fr_1fr_64px_88px]">',
    '<div className="hidden gap-1 px-2 text-[10px] text-muted-foreground/70 sm:grid sm:grid-cols-[92px_92px_60px_44px_1fr_1fr_64px_88px]">',
    1, 'TradeHeader隐藏')

# ---------- ⑥ 历史筛选控件增大（16px 防 iOS 缩放） ----------
rep(
    '"w-24 rounded border border-border bg-background px-2 py-0.5 text-[11px] outline-none focus:border-gold/60"',
    '"h-8 w-24 rounded border border-border bg-background px-2 text-base outline-none focus:border-gold/60 sm:text-xs"',
    1, '筛选输入框')
rep(
    '"rounded border border-border bg-background px-1 py-0.5 text-[11px] outline-none"',
    '"h-8 rounded border border-border bg-background px-2 text-base outline-none sm:text-xs"',
    2, '筛选下拉×2')

# ---------- ⑦ 展开更早按钮 / 弹窗宽度 ----------
rep(
    '"w-full rounded border border-border/60 bg-secondary/30 px-2 py-1 text-center text-[11px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"',
    '"w-full rounded border border-border/60 bg-secondary/30 px-2 py-2 text-center text-[11px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground sm:py-1"',
    1, '展开更早按钮')
rep('className="w-[min(400px,95vw)]"', 'className="w-[min(400px,calc(100vw-1rem))]"', 1, '充值弹窗宽')
rep('className="w-[min(420px,95vw)]"', 'className="w-[min(420px,calc(100vw-1rem))] p-4 sm:p-6"', 1, '确认弹窗宽')

if fails:
    print('FAIL:\n' + '\n'.join(fails))
    sys.exit(1)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(c)
print(f'OK trend-trade-view.tsx：{len(orig)} → {len(c)} 字符')

# ---------- 页面壳：返回按钮触控目标 ----------
with open(PAGE, 'r', encoding='utf-8') as f:
    p = f.read()
old_btn = 'className="ml-auto rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"'
new_btn = 'className="ml-auto inline-flex h-9 items-center rounded border border-border px-3 text-xs text-muted-foreground hover:text-foreground sm:h-8"'
if p.count(old_btn) != 1:
    print(f'FAIL page.tsx 返回按钮：{p.count(old_btn)} 处')
    sys.exit(1)
p = p.replace(old_btn, new_btn)
with open(PAGE, 'w', encoding='utf-8') as f:
    f.write(p)
print('OK page.tsx 返回按钮')
