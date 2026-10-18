#!/usr/bin/env python3
# Task 80-b: 报告资金口径修复——余额(balance) → 账户权益(equity)
# 口径与总览 /api/trend-trading 完全一致: equity = balance + marginUsed + unrealized
# (开仓时保证金已从余额扣除, 权益须加回占用保证金; unrealized 按标记价毛值)
import re, sys

PATH = '/home/z/my-project/src/lib/market/trend-trade/report.ts'
src = open(PATH, encoding='utf-8').read()
orig = src

def anchor(old, new, count=1):
    global src
    if old not in src:
        print(f'ANCHOR NOT FOUND: {old[:80]!r}'); sys.exit(1)
    if src.count(old) != count:
        print(f'ANCHOR AMBIGUOUS ({src.count(old)}x != {count}): {old[:80]!r}'); sys.exit(1)
    src = src.replace(old, new, count)

# ---- 1. import getEnhancedEngine (取标记价, 与总览路由同源) ----
anchor(
    "import { db } from '@/lib/db';",
    "import { db } from '@/lib/db';\nimport { getEnhancedEngine } from '@/lib/market/enhanced/engine';",
)

# ---- 2. OpenPositionRow 加 markPrice / unrealizedPnl ----
anchor(
    """  mae: number | null;
  mfe: number | null;
  scoreAtOpen: number;
}""",
    """  mae: number | null;
  mfe: number | null;
  scoreAtOpen: number;
  /** 导出时刻标记价（供价源缺失时以 entryPrice 兜底，与总览页同口径） */
  markPrice: number;
  /** 导出时刻未实现盈亏毛值 USDT（未扣平仓费/滑点；=(mark-entry)×qty×sign） */
  unrealizedPnl: number;
}""",
)

# ---- 3. TrendReportData.account 类型扩展（权益口径全量字段） ----
anchor(
    "  account: { name: string; balance: number | null; totalDeposited: number | null } | null;",
    """  account: {
    name: string;
    balance: number;
    /** 当前 OPEN 持仓占用保证金合计（开仓时已从余额扣除） */
    marginUsed: number;
    /** 当前 OPEN 持仓未实现盈亏合计（毛值，按标记价） */
    unrealizedPnl: number;
    /** 账户权益 = balance + marginUsed + unrealizedPnl（与总览页同口径） */
    equity: number;
    totalDeposited: number;
  } | null;""",
)

# ---- 4. buildTrendReportData: 权益计算（独立按 PaperPosition OPEN 全量查，与总览同口径，
#         不依赖 meta 存在性；供价失败兜底 entryPrice） ----
anchor(
    """  // —— 当前持仓快照（meta OPEN 且 PaperPosition 仍 OPEN；LIQUIDATED 待 reconcile 的不入列） ——
  const openPositions: OpenPositionRow[] = [];""",
    """  // —— 权益口径：与总览 /api/trend-trading 完全一致（equity = balance + marginUsed + unrealized）。
  // 按 PaperPosition status=OPEN 全量算（不依赖 meta 存在）；标记价走引擎多源供价，缺失兜底 entryPrice。
  const engine = getEnhancedEngine();
  const openAll = account
    ? await db.paperPosition.findMany({ where: { accountId: account.id, status: 'OPEN' } })
    : [];
  let marginUsed = 0;
  let unrealized = 0;
  const markByPosition = new Map<string, { mark: number; upnl: number }>();
  for (const p of openAll) {
    const mark = engine.autoTrader.markPriceOf(p.symbol) || p.entryPrice;
    const upnl = (mark - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
    marginUsed += p.margin;
    unrealized += upnl;
    markByPosition.set(p.id, { mark, upnl });
  }

  // —— 当前持仓快照（meta OPEN 且 PaperPosition 仍 OPEN；LIQUIDATED 待 reconcile 的不入列） ——
  const openPositions: OpenPositionRow[] = [];""",
)

# ---- 5. openPositions.push 补 markPrice / unrealizedPnl ----
anchor(
    """      mae: m.mae ?? null,
      mfe: m.mfe ?? null,
      scoreAtOpen: m.scoreAtOpen,
    });
  }""",
    """      mae: m.mae ?? null,
      mfe: m.mfe ?? null,
      scoreAtOpen: m.scoreAtOpen,
      markPrice: markByPosition.get(pos.id)?.mark ?? pos.entryPrice,
      unrealizedPnl: markByPosition.get(pos.id)?.upnl ?? 0,
    });
  }""",
)

# ---- 6. account 组装（equity 全量口径） ----
anchor(
    "    account: account ? { name: account.name, balance: account.balance, totalDeposited: account.totalDeposited } : null,",
    """    account: account
      ? {
          name: account.name,
          balance: account.balance,
          marginUsed,
          unrealizedPnl: unrealized,
          equity: account.balance + marginUsed + unrealized,
          totalDeposited: account.totalDeposited,
        }
      : null,""",
)

# ---- 7. 头部资金行：余额 → 权益（含构成拆解，AI 可自验） ----
anchor(
    "    `- 账户: ${d.account?.name ?? '—'} | 余额: ${num(d.account?.balance)} USDT | 累计充值: ${num(d.account?.totalDeposited)} USDT`,",
    "    `- 账户: ${d.account?.name ?? '—'} | 权益(equity): ${num(d.account?.equity)} USDT = 余额 ${num(d.account?.balance)} + 占用保证金 ${num(d.account?.marginUsed)} + 未实现盈亏 ${num(d.account?.unrealizedPnl)} | 累计充值: ${num(d.account?.totalDeposited)} USDT`,",
)

# ---- 8. §0 数据字典加 equity 口径行 ----
anchor(
    "  L.push('| LIQUIDATED | 强平 | pnl = -margin（全额损失）；强平是执行侧事件，非模型决策 |');",
    """  L.push('| equity | 账户权益 | balance + margin_used + unrealized_pnl；开仓时保证金已从余额扣除，权益须加回占用保证金（与总览页同口径）；unrealized 为毛值未扣平仓费 |');
  L.push('| LIQUIDATED | 强平 | pnl = -margin（全额损失）；强平是执行侧事件，非模型决策 |');""",
)

# ---- 9. §9 持仓快照表加 mark_price / unrealized_pnl 列（与头部 equity 自洽可交叉验证） ----
anchor(
    "    L.push('| symbol | exec | sig | reversed | lev | margin_USDT | hold_min_so_far | entry | liq_dist_% | mae_so_far_% | mfe_so_far_% | score |');",
    "    L.push('| symbol | exec | sig | reversed | lev | margin_USDT | mark_price | unrealized_pnl_USDT | hold_min_so_far | entry | liq_dist_% | mae_so_far_% | mfe_so_far_% | score |');",
)
anchor(
    "    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');\n    for (const p of d.openPositions) {",
    "    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');\n    for (const p of d.openPositions) {",
)
anchor(
    "        `| ${p.symbol} | ${p.execSide} | ${p.signalSide} | ${p.reversed ? 'Y' : 'N'} | ${p.leverage} | ${p.margin.toFixed(2)} | ${p.holdMinutesSoFar} | ${p.entryPrice} | ${num(p.adverseMovePctToLiq, 2)} | ${num(p.mae, 1)} | ${num(p.mfe, 1)} | ${p.scoreAtOpen} |`,",
    "        `| ${p.symbol} | ${p.execSide} | ${p.signalSide} | ${p.reversed ? 'Y' : 'N'} | ${p.leverage} | ${p.margin.toFixed(2)} | ${p.markPrice} | ${money(p.unrealizedPnl)} | ${p.holdMinutesSoFar} | ${p.entryPrice} | ${num(p.adverseMovePctToLiq, 2)} | ${num(p.mae, 1)} | ${num(p.mfe, 1)} | ${p.scoreAtOpen} |`,",
)

assert src != orig
open(PATH, 'w', encoding='utf-8').write(src)
print(f'OK: {len(re.findall(chr(10)+"  L.push", src))} render lines; all {9} anchors applied')
