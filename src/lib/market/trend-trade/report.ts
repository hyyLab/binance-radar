// ---------- 趋势自动模拟交易 · 历史分析报告（Task 80） ----------
// 受众是 LLM：用户在历史交易旁一键导出 Markdown，直接投喂给 AI 做算法优化。
// 设计原则（用户定版）：不为人眼优化，为机器可读优化——结构固定、口径显式、
// 全量流水附录、指标精确到小数。统计纯函数在 report-stats.ts（bun test 覆盖）。

import { db } from '@/lib/db';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { trendTradeRepo, type TrendTradeMetaRow } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { DEFAULT_STRATEGY_ID, listStrategies } from '@/lib/market/trend-trade/strategy/registry';
import {
  computeGroupStats,
  counterfactualModelWorld,
  groupBy,
  HOLD_BUCKET_ORDER,
  holdBucket,
  liquidationProfile,
  pnlPctOf,
  SCORE_BUCKET_ORDER,
  scoreBucket,
  sideGroupOf,
  SIDE_GROUP_ORDER,
  sweepStopLoss,
  type Counterfactual,
  type GroupStats,
  type LiquidationProfile,
  type NamedGroup,
  type ReportTrade,
  type StopLossSweepRow,
} from '@/lib/market/trend-trade/report-stats';

const LEDGER_LIMIT = 500; // 附录A 全量流水的安全上限（防止单文件过大）

export interface OpenPositionRow {
  symbol: string;
  execSide: 'LONG' | 'SHORT';
  signalSide: 'LONG' | 'SHORT';
  reversed: boolean;
  leverage: number;
  margin: number;
  entryPrice: number;
  liqPrice: number | null;
  /** 逆行多少 % 触及强平价（|liq/entry - 1| × 100） */
  adverseMovePctToLiq: number | null;
  openedAtMs: number;
  holdMinutesSoFar: number;
  mae: number | null;
  mfe: number | null;
  scoreAtOpen: number;
  /** 导出时刻标记价（供价源缺失时以 entryPrice 兜底，与总览页同口径） */
  markPrice: number;
  /** 导出时刻未实现盈亏毛值 USDT（未扣平仓费/滑点；=(mark-entry)×qty×sign） */
  unrealizedPnl: number;
}

export interface TrendReportData {
  generatedAtMs: number;
  account: {
    name: string;
    balance: number;
    /** 当前 OPEN 持仓占用保证金合计（开仓时已从余额扣除） */
    marginUsed: number;
    /** 当前 OPEN 持仓未实现盈亏合计（毛值，按标记价） */
    unrealizedPnl: number;
    /** 账户权益 = balance + marginUsed + unrealizedPnl（与总览页同口径） */
    equity: number;
    totalDeposited: number;
  } | null;
  /** 当前算法环境（TrendAutoConfig + 策略名；strategyParamsJson 原文透传） */
  config: Record<string, unknown> | null;
  sample: {
    totalClosed: number;
    firstClosedAtMs: number | null;
    lastClosedAtMs: number | null;
    reversedCount: number;
    forwardCount: number;
    maeAvailable: number;
    mfeAvailable: number;
    liquidations: number;
  };
  core: { all: GroupStats; reversed: GroupStats; forward: GroupStats };
  liquidation: {
    list: ReportTrade[];
    profile: LiquidationProfile[];
    /** 强平前曾浮盈（mfe > 0）的笔数——「连落袋环节都有改进空间」的证据 */
    hadFloatingProfit: number;
  };
  stopLossSweep: StopLossSweepRow[];
  holdBuckets: NamedGroup[];
  dimensions: {
    bySide: NamedGroup[];
    byScore: NamedGroup[];
    byHtfGate: NamedGroup[];
    bySymbol: NamedGroup[];
    byExitReason: NamedGroup[];
    byRound: NamedGroup[];
  };
  counterfactual: Counterfactual;
  openPositions: OpenPositionRow[];
  /** 全量平仓流水（closedAt 升序；超 LEDGER_LIMIT 条时截断并注明） */
  ledger: ReportTrade[];
  ledgerTruncated: boolean;
}

// ---------- DB 聚合 ----------

function strategyIdOf(meta: TrendTradeMetaRow): string {
  try {
    return (JSON.parse(meta.featuresAtOpen) as { strategyId?: string }).strategyId ?? DEFAULT_STRATEGY_ID;
  } catch {
    return DEFAULT_STRATEGY_ID; // 快照损坏 → 默认算法（与历史明细路由同口径）
  }
}

function toMs(v: Date | number | null | undefined): number | null {
  if (v == null) return null;
  return v instanceof Date ? v.getTime() : Number(v);
}

function normalizeClosed(meta: TrendTradeMetaRow, pos: NonNullable<Awaited<ReturnType<typeof db.paperPosition.findUnique>>>): ReportTrade {
  const openedAtMs = pos.openedAt.getTime();
  const closedAtMs = pos.closedAt?.getTime() ?? toMs(meta.closedAt) ?? Date.now();
  return {
    positionId: meta.positionId,
    symbol: meta.symbol,
    signalSide: meta.side as 'LONG' | 'SHORT',
    execSide: pos.side as 'LONG' | 'SHORT',
    reversed: meta.side !== pos.side,
    exitReason: pos.status === 'LIQUIDATED' ? 'LIQUIDATED' : meta.exitReason ?? 'UNKNOWN',
    exitEndReason: meta.exitEndReason ?? null,
    openedAtMs,
    closedAtMs,
    holdMinutes: Math.max(0, Math.round((closedAtMs - openedAtMs) / 60_000)),
    leverage: pos.leverage,
    margin: pos.margin,
    entryPrice: pos.entryPrice,
    exitPrice: pos.exitPrice,
    liqPrice: pos.liqPrice,
    pnlNet: meta.netPnlWithSlip ?? pos.pnl ?? 0,
    scoreAtOpen: meta.scoreAtOpen,
    entryEr: meta.entryEr ?? null,
    htfGate: meta.htfGate ?? null,
    htf15mDir: meta.htf15mDir ?? null,
    entryRound: meta.entryRound ?? null,
    mfe: meta.mfe ?? null,
    mae: meta.mae ?? null,
    strategyId: strategyIdOf(meta),
    trendCycleId: meta.trendCycleId,
  };
}

export async function buildTrendReportData(): Promise<TrendReportData> {
  const [account, config] = await Promise.all([
    db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } }),
    trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME),
  ]);

  const [closedMetas, openMetas] = await Promise.all([
    trendTradeRepo.loadMetasByStatus('CLOSED'),
    trendTradeRepo.loadMetasByStatus('OPEN'),
  ]);

  const trades: ReportTrade[] = [];
  for (const m of closedMetas) {
    const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
    if (!pos) continue;
    trades.push(normalizeClosed(m, pos));
  }
  trades.sort((a, b) => a.closedAtMs - b.closedAtMs);

  // —— 权益口径：与总览 /api/trend-trading 完全一致（equity = balance + marginUsed + unrealized）。
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
  const openPositions: OpenPositionRow[] = [];
  for (const m of openMetas) {
    const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
    if (!pos || pos.status !== 'OPEN') continue;
    openPositions.push({
      symbol: m.symbol,
      execSide: pos.side as 'LONG' | 'SHORT',
      signalSide: m.side as 'LONG' | 'SHORT',
      reversed: m.side !== pos.side,
      leverage: pos.leverage,
      margin: pos.margin,
      entryPrice: pos.entryPrice,
      liqPrice: pos.liqPrice,
      adverseMovePctToLiq: pos.liqPrice > 0 ? Math.abs(pos.liqPrice / pos.entryPrice - 1) * 100 : null,
      openedAtMs: pos.openedAt.getTime(),
      holdMinutesSoFar: Math.max(0, Math.round((Date.now() - pos.openedAt.getTime()) / 60_000)),
      mae: m.mae ?? null,
      mfe: m.mfe ?? null,
      scoreAtOpen: m.scoreAtOpen,
      markPrice: markByPosition.get(pos.id)?.mark ?? pos.entryPrice,
      unrealizedPnl: markByPosition.get(pos.id)?.upnl ?? 0,
    });
  }

  const reversedTrades = trades.filter((t) => t.reversed);
  const forwardTrades = trades.filter((t) => !t.reversed);
  const liqList = trades.filter((t) => t.exitReason === 'LIQUIDATED');

  const strategyNameById = new Map(listStrategies().map((s) => [s.id, s.name] as const));
  const currentStrategyId = config?.strategyId ?? DEFAULT_STRATEGY_ID;

  const configOut: Record<string, unknown> | null = config
    ? {
        name: config.name,
        mode: config.mode,
        reverseMode: config.reverseMode,
        strategyId: currentStrategyId,
        strategyName: strategyNameById.get(currentStrategyId) ?? currentStrategyId,
        strategyParamsJson: config.strategyParamsJson ?? null,
        initialCapital: config.initialCapital,
        marginRatio: config.marginRatio,
        leverage: config.leverage,
        maxPositions: config.maxPositions,
        slippageBps: config.slippageBps,
        waitBarConfirm: config.waitBarConfirm,
        cooldownMs: config.cooldownMs,
        peakEquity: config.peakEquity,
      }
    : null;

  const ordered = (groups: NamedGroup[], order: string[]): NamedGroup[] =>
    [...groups].sort((a, b) => {
      const ia = order.indexOf(a.key);
      const ib = order.indexOf(b.key);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return b.trades.length - a.trades.length;
    });

  return {
    generatedAtMs: Date.now(),
    account: account
      ? {
          name: account.name,
          balance: account.balance,
          marginUsed,
          unrealizedPnl: unrealized,
          equity: account.balance + marginUsed + unrealized,
          totalDeposited: account.totalDeposited,
        }
      : null,
    config: configOut,
    sample: {
      totalClosed: trades.length,
      firstClosedAtMs: trades[0]?.closedAtMs ?? null,
      lastClosedAtMs: trades[trades.length - 1]?.closedAtMs ?? null,
      reversedCount: reversedTrades.length,
      forwardCount: forwardTrades.length,
      maeAvailable: trades.filter((t) => t.mae != null).length,
      mfeAvailable: trades.filter((t) => t.mfe != null).length,
      liquidations: liqList.length,
    },
    core: {
      all: computeGroupStats(trades),
      reversed: computeGroupStats(reversedTrades),
      forward: computeGroupStats(forwardTrades),
    },
    liquidation: {
      list: liqList,
      profile: liquidationProfile(trades),
      hadFloatingProfit: liqList.filter((t) => (t.mfe ?? 0) > 0).length,
    },
    stopLossSweep: sweepStopLoss(trades),
    holdBuckets: ordered(groupBy(trades, (t) => holdBucket(t.holdMinutes)), HOLD_BUCKET_ORDER),
    dimensions: {
      bySide: ordered(groupBy(trades, sideGroupOf), SIDE_GROUP_ORDER),
      byScore: ordered(groupBy(trades, (t) => scoreBucket(t.scoreAtOpen)), SCORE_BUCKET_ORDER),
      byHtfGate: groupBy(trades, (t) => t.htfGate).sort((a, b) => b.trades.length - a.trades.length),
      bySymbol: groupBy(trades, (t) => t.symbol).sort((a, b) => b.trades.length - a.trades.length),
      byExitReason: groupBy(trades, (t) => t.exitReason).sort((a, b) => b.trades.length - a.trades.length),
      byRound: groupBy(trades, (t) => (t.entryRound == null ? null : String(t.entryRound))).sort(
        (a, b) => b.trades.length - a.trades.length,
      ),
    },
    counterfactual: counterfactualModelWorld(trades),
    openPositions,
    ledger: trades.slice(0, LEDGER_LIMIT),
    ledgerTruncated: trades.length > LEDGER_LIMIT,
  };
}

// ---------- Markdown 渲染（确定性、机器可读） ----------

function fmt8(ms: number | null | undefined, full = false): string {
  if (ms == null) return '—';
  const d = new Date(ms + 8 * 3_600_000); // UTC+8
  return full ? d.toISOString().slice(0, 19).replace('T', ' ') : d.toISOString().slice(5, 16).replace('T', ' ');
}

function money(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

function num(n: number | null | undefined, digits = 2, suffix = ''): string {
  return n == null ? '—' : `${n.toFixed(digits)}${suffix}`;
}

function pfStr(s: GroupStats): string {
  return s.profitFactor == null ? (s.grossWin > 0 ? 'inf' : '—') : s.profitFactor.toFixed(2);
}

const EXIT_SHORT: Record<string, string> = {
  TREND_ENDED: 'ENDED',
  REVERSE_CONFIRMED: 'REVCONF',
  LIQUIDATED: 'LIQ',
  MANUAL: 'MANUAL',
  STOP_LOSS: 'STOPLOSS',
  SPIKE_TAKE: 'SPIKE',
  TRAIL_TAKE: 'TRAIL',
  WEAKNESS_EARLY: 'WEAK',
};

function exitShort(r: string): string {
  return EXIT_SHORT[r] ?? r.slice(0, 12);
}

function dimTable(title: string, groups: NamedGroup[], keyLabel: string): string {
  const lines = [
    `### ${title}`,
    `| ${keyLabel} | trades | winRate% | netPnl_USDT | profit_factor | avg_pnl_pct_margin | liquidations |`,
    '|---|---|---|---|---|---|---|',
  ];
  for (const g of groups) {
    lines.push(
      `| ${g.key} | ${g.stats.trades} | ${num(g.stats.winRate, 1)} | ${money(g.stats.netPnl)} | ${pfStr(g.stats)} | ${num(g.stats.avgPnlPct, 1)} | ${g.stats.liquidations} |`,
    );
  }
  return lines.join('\n');
}

export function renderReportMarkdown(d: TrendReportData): string {
  const L: string[] = [];
  const { core, sample } = d;

  L.push('# 趋势自动交易历史分析报告（供 LLM 算法优化）');
  L.push('');
  L.push(
    `- generated_at(+08:00): ${fmt8(d.generatedAtMs, true)}`,
    `- 账户: ${d.account?.name ?? '—'} | 权益(equity): ${num(d.account?.equity)} USDT = 余额 ${num(d.account?.balance)} + 占用保证金 ${num(d.account?.marginUsed)} + 未实现盈亏 ${num(d.account?.unrealizedPnl)} | 累计充值: ${num(d.account?.totalDeposited)} USDT`,
    `- 当前策略: ${String(d.config?.strategyId ?? '—')}（${String(d.config?.strategyName ?? '—')}）| reverseMode: ${String(d.config?.reverseMode ?? '—')}（1=反向跟随开启，0=正常跟随）`,
    `- 样本: 已平仓 ${sample.totalClosed} 笔（反向 ${sample.reversedCount} / 正向 ${sample.forwardCount}），时间跨度 ${fmt8(sample.firstClosedAtMs)} ~ ${fmt8(sample.lastClosedAtMs)}（+08:00）`,
  );
  L.push('');
  L.push('> 用途：评估「趋势引擎反向跟随」（正不行则反行）的期望值与尾部风险（强平），并给出可执行的算法/参数修改建议。所有金额单位 USDT；pnl_pct 相对保证金；时间戳均为 UTC+8。引用结论时请注明小节编号。');

  // —— §0 数据字典 ——
  L.push('');
  L.push('## 0. 数据字典与口径（必读）');
  L.push('| 字段 | 含义 | 口径/单位 |');
  L.push('|---|---|---|');
  L.push('| pnlNet | 单笔净盈亏 | USDT；netPnlWithSlip ?? pnl（已扣手续费+双边滑点估算，统计主口径） |');
  L.push('| pnl_pct | 单笔盈亏比例 | pnlNet / margin × 100（占保证金 %） |');
  L.push('| signal_side | 模型信号侧 | TrendTradeMeta.side（策略世界语义） |');
  L.push('| exec_side | 实际执行侧 | PaperPosition.side；reversed = signal_side ≠ exec_side |');
  L.push('| mfe / mae | 持仓期最大浮盈/最大浮亏 | 占保证金 %；mfe≥0 / mae≤0；按标记价逐 tick 采样，**可能低估** |');
  L.push('| profit_factor | 利润因子 | gross_win / abs(gross_loss)；无亏损单 = inf |');
  L.push('| expectancy | 每笔期望值 | netPnl / trades（USDT） |');
  L.push('| max_drawdown | 最大回撤 | USDT；按平仓时间升序累计净盈亏的最大峰谷差 |');
  L.push('| equity | 账户权益 | balance + margin_used + unrealized_pnl；开仓时保证金已从余额扣除，权益须加回占用保证金（与总览页同口径）；unrealized 为毛值未扣平仓费 |');
  L.push('| LIQUIDATED | 强平 | pnl = -margin（全额损失）；强平是执行侧事件，非模型决策 |');
  L.push('| exit_reason 枚举 | TREND_ENDED=趋势确认结束 / REVERSE_CONFIRMED=反向确认 / LIQUIDATED=强平 / MANUAL=人工 / 其余为策略层个性离场 |');
  L.push('');
  L.push('**What-if 止损模拟方法**：设「浮亏达保证金 S% 即平仓」。对 mae != null 且 mae <= -S 的单（含先亏后赚单）在 -S% 截断：pnlNet = -margin × S/100。局限：① mae 为采样极值，可能漏掉瞬时刻度（模拟偏保守）；② 止损成交按精确 -S% 计，未含额外滑点；③ mae 缺失的老单不参与（数量在表中 uncovered 列）。');

  // —— §1 系统上下文 ——
  L.push('');
  L.push('## 1. 系统上下文（当前算法环境）');
  L.push('```json');
  L.push(JSON.stringify({ account: d.account, config: d.config }, null, 2));
  L.push('```');

  // —— §2 样本概览 ——
  L.push('');
  L.push('## 2. 样本概览');
  L.push(
    `- 已平仓 ${sample.totalClosed} 笔 | 有 mae 样本 ${sample.maeAvailable} 笔 | 有 mfe 样本 ${sample.mfeAvailable} 笔 | 强平 ${sample.liquidations} 笔`,
  );

  // —— §3 核心指标 ——
  L.push('');
  L.push('## 3. 核心指标：全部 vs 反向 vs 正向');
  L.push('| metric | all | reversed | forward |');
  L.push('|---|---|---|---|');
  const rows: [string, (s: GroupStats) => string][] = [
    ['trades', (s) => String(s.trades)],
    ['win_rate_%', (s) => num(s.winRate, 1)],
    ['net_pnl_USDT', (s) => money(s.netPnl)],
    ['gross_win_USDT', (s) => s.grossWin.toFixed(2)],
    ['gross_loss_USDT', (s) => s.grossLoss.toFixed(2)],
    ['profit_factor', pfStr],
    ['expectancy_USDT_per_trade', (s) => num(s.expectancy)],
    ['avg_win_USDT', (s) => num(s.avgWin)],
    ['avg_loss_USDT', (s) => num(s.avgLoss)],
    ['payoff_ratio', (s) => num(s.payoffRatio)],
    ['avg_pnl_pct_margin', (s) => num(s.avgPnlPct, 1)],
    ['median_pnl_pct_margin', (s) => num(s.medianPnlPct, 1)],
    ['max_drawdown_USDT', (s) => s.maxDrawdown.toFixed(2)],
    ['max_consecutive_losses', (s) => String(s.maxConsecLoss)],
    ['liquidations', (s) => String(s.liquidations)],
    ['liquidation_rate_%', (s) => num(s.liquidationRate, 1)],
    ['avg_hold_minutes', (s) => num(s.avgHoldMin, 0)],
    ['median_hold_minutes', (s) => num(s.medianHoldMin, 0)],
  ];
  for (const [label, pick] of rows) L.push(`| ${label} | ${pick(core.all)} | ${pick(core.reversed)} | ${pick(core.forward)} |`);

  // —— §4 强平专项 ——
  L.push('');
  L.push('## 4. 强平专项（尾部风险）');
  if (d.liquidation.list.length === 0) {
    L.push('样本内无强平记录。');
  } else {
    L.push(`强平 ${d.liquidation.list.length} 笔，其中强平前曾浮盈（mfe>0）${d.liquidation.hadFloatingProfit} 笔。`);
    L.push('');
    L.push('### 4.1 强平单画像 vs 其他单（中位数）');
    L.push('| metric | liquidated | others |');
    L.push('|---|---|---|');
    for (const p of d.liquidation.profile) L.push(`| ${p.metric} | ${num(p.liquidated, 2)} | ${num(p.others, 2)} |`);
    L.push('');
    L.push('### 4.2 强平单逐笔明细');
    L.push('| closed_at(+08) | symbol | exec | sig | lev | margin_USDT | hold_min | pnl_pct_% | pnl_USDT | score | mae_% | mfe_% |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const t of d.liquidation.list) {
      L.push(
        `| ${fmt8(t.closedAtMs, true)} | ${t.symbol} | ${t.execSide} | ${t.signalSide} | ${t.leverage} | ${t.margin.toFixed(2)} | ${t.holdMinutes} | ${pnlPctOf(t).toFixed(1)} | ${money(t.pnlNet)} | ${t.scoreAtOpen} | ${num(t.mae, 1)} | ${num(t.mfe, 1)} |`,
      );
    }
  }

  // —— §5 What-if 止损扫描 ——
  L.push('');
  L.push('## 5. What-if 止损扫描（基于 MAE 路径近似）');
  L.push('| stop_%_of_margin | clipped | clipped_winners | uncovered | adjusted_net_USDT | adjusted_profit_factor | delta_vs_baseline_USDT |');
  L.push('|---|---|---|---|---|---|---|');
  L.push(`| 0(基准,不止损) | 0 | 0 | 0 | ${money(core.all.netPnl)} | ${pfStr(core.all)} | +0.00 |`);
  for (const r of d.stopLossSweep) {
    L.push(
      `| -${r.stopPct} | ${r.clipped} | ${r.clippedWinners} | ${r.uncovered} | ${money(r.stats.netPnl)} | ${pfStr(r.stats)} | ${money(r.deltaNetPnl)} |`,
    );
  }

  // —— §6 持仓时长分层 ——
  L.push('');
  L.push('## 6. 持仓时长分层（描述性，未模拟提前平仓）');
  L.push(dimTable('hold buckets', d.holdBuckets, 'hold_bucket').split('\n').slice(1).join('\n'));

  // —— §7 维度透视 ——
  L.push('');
  L.push('## 7. 维度透视（trades<5 的组为小样本，谨慎解读）');
  L.push(dimTable('按执行方向×反向（rev=反向, fwd=正向）', d.dimensions.bySide, 'side_group'));
  L.push('');
  L.push(dimTable('按开仓时 UTE 评分分桶（分数越高=趋势越强）', d.dimensions.byScore, 'score_bucket'));
  L.push('');
  L.push(dimTable('按高周期门控（ALIGNED=高周期同向，反向单处于逆大周期）', d.dimensions.byHtfGate, 'htf_gate'));
  L.push('');
  L.push(dimTable('按币种', d.dimensions.bySymbol, 'symbol'));
  L.push('');
  L.push(dimTable('按平仓原因', d.dimensions.byExitReason, 'exit_reason'));
  L.push('');
  L.push(dimTable('按入场轮次（1=周期首次，2+=走弱后再入场）', d.dimensions.byRound, 'entry_round'));

  // —— §8 模型世界对照 ——
  L.push('');
  L.push('## 8. 模型世界对照（反事实估算）');
  L.push(
    `- 实际净盈亏: ${money(d.counterfactual.actualNetPnl)} USDT（反向 ${money(d.counterfactual.reversedPnl)} + 正向 ${money(d.counterfactual.forwardPnl)}）`,
    `- 模型世界净盈亏(若全部不反向): ≈ ${money(d.counterfactual.modelWorldNetPnl)} USDT`,
    `- 口径: ${d.counterfactual.note}`,
  );

  // —— §9 当前持仓快照 ——
  L.push('');
  L.push('## 9. 当前持仓快照（导出时刻）');
  if (d.openPositions.length === 0) {
    L.push('无持仓。');
  } else {
    L.push('| symbol | exec | sig | reversed | lev | margin_USDT | mark_price | unrealized_pnl_USDT | hold_min_so_far | entry | liq_dist_% | mae_so_far_% | mfe_so_far_% | score |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const p of d.openPositions) {
      L.push(
        `| ${p.symbol} | ${p.execSide} | ${p.signalSide} | ${p.reversed ? 'Y' : 'N'} | ${p.leverage} | ${p.margin.toFixed(2)} | ${p.markPrice} | ${money(p.unrealizedPnl)} | ${p.holdMinutesSoFar} | ${p.entryPrice} | ${num(p.adverseMovePctToLiq, 2)} | ${num(p.mae, 1)} | ${num(p.mfe, 1)} | ${p.scoreAtOpen} |`,
      );
    }
  }

  // —— §10 附录A 全量流水 ——
  L.push('');
  L.push(`## 10. 附录A：全量平仓流水（closedAt 升序${d.ledgerTruncated ? `；仅含最近 ${LEDGER_LIMIT} 条，共 ${sample.totalClosed} 条` : ''}）`);
  L.push('| # | closed_at(+08) | symbol | exec | sig | rev | exit | hold_min | margin | pnl_pct_% | pnl_USDT | cum_pnl_USDT | score | mae_% | mfe_% | round |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  let cum = 0;
  d.ledger.forEach((t, i) => {
    cum += t.pnlNet;
    L.push(
      `| ${i + 1} | ${fmt8(t.closedAtMs, true)} | ${t.symbol} | ${t.execSide} | ${t.signalSide} | ${t.reversed ? 'R' : 'N'} | ${exitShort(t.exitReason)} | ${t.holdMinutes} | ${t.margin.toFixed(2)} | ${pnlPctOf(t).toFixed(1)} | ${money(t.pnlNet)} | ${money(cum)} | ${t.scoreAtOpen} | ${num(t.mae, 1)} | ${num(t.mfe, 1)} | ${t.entryRound ?? '—'} |`,
    );
  });

  // —— §11 附录B 数据质量 ——
  L.push('');
  L.push('## 11. 附录B：数据质量与已知口径坑');
  L.push(
    `- mae/mfe 自 Task 56 起采集：有 mae 样本 ${sample.maeAvailable}/${sample.totalClosed}，有 mfe 样本 ${sample.mfeAvailable}/${sample.totalClosed}；缺失值在表中为 —，What-if 扫描不参与（见 uncovered 列）`,
    '- mae/mfe 为标记价逐 tick 采样极值，可能低估瞬时极值（对 What-if 止损结果偏保守）',
    '- LIQUIDATED 单 pnl = -margin（模拟全额损失），mae 通常 ≈ -100',
    `- 附录A 流水最多 ${LEDGER_LIMIT} 条${d.ledgerTruncated ? '（本报告已截断）' : '（未截断）'}`,
    '- 反向模式的执行侧与模型侧逐笔镜像（同入场/同退出时机），因此 §8 的反事实估算仅对非强平单近似成立',
    '- 趋势评分为启发式证据分（0-100），非概率；趋势确认 ≠ 未来延续',
  );

  return L.join('\n');
}
