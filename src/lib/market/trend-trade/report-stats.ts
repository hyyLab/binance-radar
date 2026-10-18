// ---------- 趋势自动模拟交易 · 报告统计纯函数（Task 80） ----------
// 报告受众是 LLM（用户把导出的 Markdown 直接投喂给 AI 做算法优化），因此本模块
// 只做确定性统计，不做任何「人类友好」取舍：全部指标给精确数值 + 明确口径。
// 本文件禁止 import db / 环境相关依赖——保证 bun test 无需数据库即可验证。

/** 归一化后的单笔已平仓交易（报告统计的最小单元） */
export interface ReportTrade {
  positionId: string;
  symbol: string;
  /** 模型信号侧（TrendTradeMeta.side = 策略世界语义；Task 75 反向模式下与执行侧镜像） */
  signalSide: 'LONG' | 'SHORT';
  /** 实际执行侧（PaperPosition.side；历史/K线展示口径，Task 77） */
  execSide: 'LONG' | 'SHORT';
  /** 是否反向执行（signalSide ≠ execSide） */
  reversed: boolean;
  /** 平仓原因（LIQUIDATED 优先于 meta.exitReason，与历史明细路由同口径） */
  exitReason: string;
  /** 模型细分结束原因（DECAY / STRUCTURE_INVALIDATION / CONFIRMED_REVERSAL） */
  exitEndReason: string | null;
  openedAtMs: number;
  closedAtMs: number;
  holdMinutes: number;
  leverage: number;
  margin: number;
  entryPrice: number;
  exitPrice: number | null;
  liqPrice: number | null;
  /** 主口径净盈亏（netPnlWithSlip ?? pnl ?? 0，USDT，已含手续费与滑点估算） */
  pnlNet: number;
  /** 开仓时 UTE 趋势评分（0-100 启发式证据分） */
  scoreAtOpen: number;
  /** 开仓时 1m 效率比（入场质量快照） */
  entryEr: number | null;
  /** 开仓时高周期门控（ALIGNED / NEUTRAL / OPPOSED / INVALID） */
  htfGate: string | null;
  /** 开仓时 15m 方向（up / down / flat） */
  htf15mDir: string | null;
  /** 同周期第几轮开仓（1 = 首次） */
  entryRound: number | null;
  /** 持仓期最大有利浮盈（占保证金 %，≥0；按标记价采样，可能低估） */
  mfe: number | null;
  /** 持仓期最大不利浮亏（占保证金 %，≤0；按标记价采样，可能低估） */
  mae: number | null;
  /** 开仓算法 id（featuresAtOpen.strategyId；缺失兜底默认算法） */
  strategyId: string;
  trendCycleId: string;
}

/** 占保证金 % 的盈亏（pnlNet / margin × 100） */
export function pnlPctOf(t: ReportTrade): number {
  return t.margin > 0 ? (t.pnlNet / t.margin) * 100 : 0;
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 分组核心指标（报告所有表格的列都从这里出） */
export interface GroupStats {
  trades: number;
  wins: number; // pnlNet > 0
  losses: number; // pnlNet < 0
  breakeven: number; // pnlNet === 0
  /** 胜率 %（wins / trades；空组 null） */
  winRate: number | null;
  /** 主口径净盈亏合计（USDT） */
  netPnl: number;
  /** 盈利单净盈亏合计（USDT，>0） */
  grossWin: number;
  /** 亏损单净盈亏合计（USDT，≤0） */
  grossLoss: number;
  /** 利润因子 = grossWin / |grossLoss|（无亏损单 → null，正文以 ∞ 展示） */
  profitFactor: number | null;
  /** 每笔期望值 = netPnl / trades（USDT） */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** 盈亏比 = |avgWin / avgLoss| */
  payoffRatio: number | null;
  /** 平均单笔盈亏（占保证金 %） */
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  /** 最大回撤（USDT，≥0；按 closedAt 升序累计净盈亏的最大峰谷差） */
  maxDrawdown: number;
  /** 最长连续亏损笔数 */
  maxConsecLoss: number;
  liquidations: number;
  liquidationRate: number | null; // %
  avgHoldMin: number | null;
  medianHoldMin: number | null;
}

export function emptyGroupStats(): GroupStats {
  return {
    trades: 0, wins: 0, losses: 0, breakeven: 0, winRate: null, netPnl: 0,
    grossWin: 0, grossLoss: 0, profitFactor: null, expectancy: null,
    avgWin: null, avgLoss: null, payoffRatio: null, avgPnlPct: null,
    medianPnlPct: null, maxDrawdown: 0, maxConsecLoss: 0, liquidations: 0,
    liquidationRate: null, avgHoldMin: null, medianHoldMin: null,
  };
}

export function computeGroupStats(trades: ReportTrade[]): GroupStats {
  const s = emptyGroupStats();
  if (trades.length === 0) return s;
  const sorted = [...trades].sort((a, b) => a.closedAtMs - b.closedAtMs);
  s.trades = sorted.length;
  let cum = 0;
  let peak = 0;
  let consec = 0;
  const pnlPcts: number[] = [];
  for (const t of sorted) {
    s.netPnl += t.pnlNet;
    if (t.pnlNet > 0) {
      s.wins += 1;
      s.grossWin += t.pnlNet;
      consec = 0;
    } else if (t.pnlNet < 0) {
      s.losses += 1;
      s.grossLoss += t.pnlNet;
      consec += 1;
      if (consec > s.maxConsecLoss) s.maxConsecLoss = consec;
    } else {
      s.breakeven += 1;
    }
    if (t.exitReason === 'LIQUIDATED') s.liquidations += 1;
    cum += t.pnlNet;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > s.maxDrawdown) s.maxDrawdown = dd;
    pnlPcts.push(pnlPctOf(t));
    s.avgHoldMin = (s.avgHoldMin ?? 0) + t.holdMinutes;
  }
  s.winRate = (s.wins / s.trades) * 100;
  s.profitFactor = s.grossLoss < 0 ? s.grossWin / Math.abs(s.grossLoss) : null;
  s.expectancy = s.netPnl / s.trades;
  s.avgWin = s.wins > 0 ? s.grossWin / s.wins : null;
  s.avgLoss = s.losses > 0 ? s.grossLoss / s.losses : null;
  s.payoffRatio = s.avgWin != null && s.avgLoss != null && s.avgLoss !== 0 ? Math.abs(s.avgWin / s.avgLoss) : null;
  s.avgPnlPct = pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length;
  s.medianPnlPct = median(pnlPcts);
  s.liquidationRate = (s.liquidations / s.trades) * 100;
  s.avgHoldMin = (s.avgHoldMin ?? 0) / s.trades;
  s.medianHoldMin = median(sorted.map((t) => t.holdMinutes));
  return s;
}

// ---------- What-if 止损扫描（MAE 路径近似） ----------
// 方法：设「浮亏达保证金 S% 即平仓」。对 mae != null 且 mae <= -S 的单，
// 无论最终盈亏（含先亏后赚的单）都视为在 -S% 处离场：pnlNet = -margin × S/100。
// 局限（正文必须声明）：① mae 为标记价采样极值，可能漏掉瞬时刻度 → 模拟偏保守；
// ② 止损成交价按精确 -S% 计，未含额外滑点；③ mae 缺失（Task 56 前老数据）不参与。

export interface StopLossWhatIfResult {
  trades: ReportTrade[];
  clipped: number;
  clippedWinners: number;
  uncovered: number; // mae 缺失未参与模拟的笔数
}

export function applyStopLossWhatIf(trades: ReportTrade[], stopPct: number): StopLossWhatIfResult {
  const out: ReportTrade[] = [];
  let clipped = 0;
  let clippedWinners = 0;
  let uncovered = 0;
  for (const t of trades) {
    if (t.mae == null) {
      uncovered += 1;
      out.push(t);
      continue;
    }
    if (t.mae <= -stopPct) {
      clipped += 1;
      if (t.pnlNet > 0) clippedWinners += 1;
      out.push({ ...t, pnlNet: -(t.margin * stopPct) / 100 });
    } else {
      out.push(t);
    }
  }
  return { trades: out, clipped, clippedWinners, uncovered };
}

export interface StopLossSweepRow extends StopLossWhatIfResult {
  stopPct: number;
  stats: GroupStats;
  deltaNetPnl: number; // 调整后净利 - 基准净利（USDT）
}

export function sweepStopLoss(trades: ReportTrade[], levels: number[] = [10, 20, 30, 40, 50, 60, 80]): StopLossSweepRow[] {
  const base = computeGroupStats(trades).netPnl;
  return levels.map((stopPct) => {
    const r = applyStopLossWhatIf(trades, stopPct);
    const stats = computeGroupStats(r.trades);
    return { ...r, stopPct, stats, deltaNetPnl: stats.netPnl - base };
  });
}

// ---------- 分桶与维度 ----------

export function scoreBucket(score: number): string {
  if (score < 50) return '<50';
  if (score < 70) return '50-69';
  if (score < 85) return '70-84';
  return '>=85';
}

export function holdBucket(minutes: number): string {
  if (minutes < 30) return '<30m';
  if (minutes < 120) return '30m-2h';
  if (minutes < 360) return '2-6h';
  if (minutes < 1440) return '6-24h';
  return '>=24h';
}

export const HOLD_BUCKET_ORDER = ['<30m', '30m-2h', '2-6h', '6-24h', '>=24h'];
export const SCORE_BUCKET_ORDER = ['<50', '50-69', '70-84', '>=85'];
export const SIDE_GROUP_ORDER = ['rev-long', 'rev-short', 'fwd-long', 'fwd-short'];

/** 执行方向 × 是否反向 的分组键 */
export function sideGroupOf(t: ReportTrade): string {
  return `${t.reversed ? 'rev' : 'fwd'}-${t.execSide.toLowerCase()}`;
}

export interface NamedGroup {
  key: string;
  trades: ReportTrade[];
  stats: GroupStats;
}

/** 按任意键分组（keyFn 返回 null 的样本落入 'unknown' 组） */
export function groupBy(trades: ReportTrade[], keyFn: (t: ReportTrade) => string | null): NamedGroup[] {
  const map = new Map<string, ReportTrade[]>();
  for (const t of trades) {
    const k = keyFn(t) ?? 'unknown';
    const arr = map.get(k);
    if (arr) arr.push(t);
    else map.set(k, [t]);
  }
  return [...map.entries()].map(([key, list]) => ({ key, trades: list, stats: computeGroupStats(list) }));
}

/** 强平单 vs 其他单的画像对比（全部取中位数；|mae| 转正便于阅读） */
export interface LiquidationProfile {
  metric: string;
  liquidated: number | null;
  others: number | null;
}

export function liquidationProfile(trades: ReportTrade[]): LiquidationProfile[] {
  const liq = trades.filter((t) => t.exitReason === 'LIQUIDATED');
  const rest = trades.filter((t) => t.exitReason !== 'LIQUIDATED');
  const med = (list: ReportTrade[], pick: (t: ReportTrade) => number | null): number | null =>
    median(list.map(pick).filter((v): v is number => v != null));
  return [
    { metric: 'hold_minutes_median', liquidated: med(liq, (t) => t.holdMinutes), others: med(rest, (t) => t.holdMinutes) },
    { metric: 'abs_mae_median', liquidated: med(liq, (t) => (t.mae == null ? null : Math.abs(t.mae))), others: med(rest, (t) => (t.mae == null ? null : Math.abs(t.mae))) },
    { metric: 'mfe_median', liquidated: med(liq, (t) => t.mfe), others: med(rest, (t) => t.mfe) },
    { metric: 'score_at_open_median', liquidated: med(liq, (t) => t.scoreAtOpen), others: med(rest, (t) => t.scoreAtOpen) },
    { metric: 'leverage_median', liquidated: med(liq, (t) => t.leverage), others: med(rest, (t) => t.leverage) },
    { metric: 'pnl_pct_median', liquidated: med(liq, (t) => pnlPctOf(t)), others: med(rest, (t) => pnlPctOf(t)) },
  ];
}

/** 模型世界对照（反事实）：反向单若未反向，其模型侧盈亏 ≈ -pnlNet（同入场/同退出、镜像方向）。
 *  局限：强平是执行侧事件——被强平的反向单在模型世界可能尚未触发离场，其「未实现盈亏」无法还原，
 *  因此模型世界值是近似下界口径，仅供方向性判断。 */
export interface Counterfactual {
  actualNetPnl: number;
  reversedPnl: number;
  forwardPnl: number;
  modelWorldNetPnl: number;
  note: string;
}

export function counterfactualModelWorld(trades: ReportTrade[]): Counterfactual {
  const reversed = trades.filter((t) => t.reversed);
  const forward = trades.filter((t) => !t.reversed);
  const reversedPnl = reversed.reduce((a, t) => a + t.pnlNet, 0);
  const forwardPnl = forward.reduce((a, t) => a + t.pnlNet, 0);
  const liquidatedReversed = reversed.filter((t) => t.exitReason === 'LIQUIDATED').length;
  return {
    actualNetPnl: reversedPnl + forwardPnl,
    reversedPnl,
    forwardPnl,
    modelWorldNetPnl: forwardPnl + -reversedPnl,
    note:
      `近似口径：模型世界 = 正向单原值 + 反向单取镜像(-pnl)。${liquidatedReversed} 笔被强平的反向单` +
      `在模型世界可能仍持有（强平是执行侧事件，模型离场以信号为准），其未实现盈亏未计入。`,
  };
}
