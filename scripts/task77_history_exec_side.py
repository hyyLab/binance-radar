#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 77: 反向跟随开启后，历史记录方向改为实际执行方向。

背景：Task 75 反向模式下 meta.side 保持模型信号侧（策略世界语义，刻意设计），
PaperPosition.side 才是真实执行侧。历史明细 API（trades/route.ts）此前输出
meta.side → 历史卡片/K线标记显示「信号方向」与实际仓位相反。

修复（三处）：
1. trades API 列表：side = pos.side（执行方向），新增 signalSide（模型信号侧）
   与 reversed（两者不一致标记）；K线开仓价线颜色/开仓箭头方向随之自动正确。
2. use-trend-trade.ts：TrendTradeRow 类型补 signalSide/reversed，side 注释更新。
3. trend-trade-view.tsx 历史卡片（移动端+桌面端两处）：方向字旁加「反」徽标
   （仅 reversed 时显示，title 说明 信号→执行 映射）。

不改 auto-trader/repo：meta.side 模型语义是 evaluateExit/轮次/再入场依赖，
不加列不回填——trades API 本就 join PaperPosition，执行侧随时可得。
"""
import io
import sys

def patch(path, pairs):
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new, tag in pairs:
        if old not in src:
            print(f'  [FAIL] {tag}: 锚未命中 -> {path}')
            sys.exit(1)
        if src.count(old) != 1:
            print(f'  [FAIL] {tag}: 锚不唯一（{src.count(old)} 处）-> {path}')
            sys.exit(1)
        src = src.replace(old, new)
        print(f'  [OK] {tag}')
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)

# ---------- 1) trades API：side 改执行方向 + signalSide/reversed ----------
patch('src/app/api/trend-trading/trades/route.ts', [(
    """      rows.push({
        positionId: m.positionId,
        symbol: m.symbol,
        base: m.symbol.replace(/USDT$/, ''),
        side: m.side,
        strategyId,""",
    """      rows.push({
        positionId: m.positionId,
        symbol: m.symbol,
        base: m.symbol.replace(/USDT$/, ''),
        // Task 77：side = 实际执行方向（PaperPosition 真实成交侧）。反向跟随开启时
        // meta.side 是模型信号侧（策略世界语义，Task 75 刻意设计），与执行侧互为镜像
        // ——历史/K线必须按执行方向展示；signalSide 保留模型语义供审计对照。
        side: pos.side as 'LONG' | 'SHORT',
        signalSide: m.side as 'LONG' | 'SHORT',
        reversed: m.side !== pos.side,
        strategyId,""",
    'trades API side=执行方向',
)])

# ---------- 2) hook 类型：TrendTradeRow 补字段 ----------
patch('src/hooks/use-trend-trade.ts', [(
    """export interface TrendTradeRow {
  positionId: string;
  symbol: string;
  base: string;
  side: 'LONG' | 'SHORT';""",
    """export interface TrendTradeRow {
  positionId: string;
  symbol: string;
  base: string;
  /** 实际执行方向（反向跟随开启时 = 模型信号取反；历史/K线/盈亏展示均按此） */
  side: 'LONG' | 'SHORT';
  /** Task 77：模型信号方向（反向跟随开启时与 side 互为镜像；正常跟随 = side） */
  signalSide?: 'LONG' | 'SHORT';
  /** Task 77：是否反向执行（signalSide ≠ side）——历史卡片显示「反」徽标 */
  reversed?: boolean;""",
    'TrendTradeRow 类型补 signalSide/reversed',
)])

# ---------- 3) 前端历史卡片：移动端 + 桌面端方向徽标 ----------
REVERSE_BADGE = """          {t.reversed && (
            <span
              className="ml-0.5 rounded bg-gold/15 px-0.5 text-[9px] font-semibold text-gold"
              title={`反向跟随：模型信号${t.signalSide === 'LONG' ? '多' : '空'} → 实际执行${t.side === 'LONG' ? '多' : '空'}`}
            >
              反
            </span>
          )}
"""
patch('src/components/trend-trade/trend-trade-view.tsx', [
    (
        """        <span className={cn('shrink-0 font-bold', t.side === 'LONG' ? 'text-up' : 'text-down')}>
          {t.side === 'LONG' ? '多' : '空'}
        </span>""",
        """        <span className={cn('shrink-0 font-bold', t.side === 'LONG' ? 'text-up' : 'text-down')}>
          {t.side === 'LONG' ? '多' : '空'}
""" + REVERSE_BADGE + """        </span>""",
        '移动端方向徽标',
    ),
    (
        """      <span className={cn('hidden font-bold sm:block', t.side === 'LONG' ? 'text-up' : 'text-down')}>
        {t.side === 'LONG' ? '多' : '空'}
      </span>""",
        """      <span className={cn('hidden font-bold sm:block', t.side === 'LONG' ? 'text-up' : 'text-down')}>
        {t.side === 'LONG' ? '多' : '空'}
""" + REVERSE_BADGE.replace('          ', '        ') + """      </span>""",
        '桌面端方向徽标',
    ),
])

print('全部补丁完成')
