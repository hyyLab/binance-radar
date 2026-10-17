// ---------- 历史回放 · 双模型对比（Task 54 §六） ----------
// 用法：bun scripts/replay/run-replay.ts [--capital 100] [--maxpos 4]
//
// 严格时间顺序：逐分钟推进；决策只用「该分钟已收盘」的 K 线；成交假设 = 下一根 1m
// 开盘价（不使用信号 K 线收盘价、不使用未来行情）。两套策略消费同一份数据与同一套
// UTE 评估（方向唯一来源），差异仅在生命周期/退出规则——对应线上 Task 53（v1 基线）
// 与 Task 54（v2 改进）的真实实现：
//   v1 基线：UTE confirmed 开仓；UTE 离开 confirmed（idle/反向）即平仓（无结束确认缓冲）
//   v2 改进：lifecycle CONFIRMED_* 开仓；lifecycle ENDED（反向确认/衰减确认）才平仓，
//            含 END_CONFIRM_BARS 根缓冲、深回撤容忍带、结构失效证据
// 成本：双边 Taker 0.05% + 单边 2bp 滑点估算；20% 权益保证金、20x、最多 4 仓、无止盈止损；
//       强平按币安逐仓公式（mark 触及 liq → -margin）。
//
// ⚠️ 回放结果为样本内统计，不构成盈利能力证明；参数未做多周期/多市场稳健性验证。

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { assessTrend, scanAnomalyCandidates, toClosedBars, type TrendState, type WatchOhlcvSeries } from 'universal-trend-engine';
import { computeVolatilityFeatures, assessHtf, DEFAULT_INDICATOR_CFG } from '../../src/lib/market/trend-watch/indicators';
import { createLifecycleState, stepLifecycle } from '../../src/lib/market/trend-watch/lifecycle';
import { TREND_WATCH, trendEngineConfig } from '../../src/lib/market/trend-watch/config';
import { liqPriceFor, TAKER_FEE } from '../../src/lib/market/futures';

const DATA_DIR = '/home/z/my-project/scripts/replay/data';
const args = process.argv.slice(2);
function argNum(name: string, def: number): number {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
}
const CAPITAL = argNum('--capital', 100);
const MAXPOS = argNum('--maxpos', 4);

interface Bar { t: number; o: number; h: number; l: number; c: number; qv: number }

const INTERVAL_MS = 60_000;
const trendCfg = trendEngineConfig();

// ============ 数据加载 ============

const files = existsSync(DATA_DIR) ? readdirSafe(DATA_DIR) : [];
const symbols = files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
if (symbols.length === 0) {
  console.error('无数据：先运行 bun scripts/replay/fetch-history.ts');
  process.exit(1);
}
const history = new Map<string, Bar[]>();
for (const s of symbols) {
  history.set(s, JSON.parse(readFileSync(`${DATA_DIR}/${s}.json`, 'utf8')) as Bar[]);
}
const t0 = Math.min(...[...history.values()].map((b) => b[0]!.t));
const t1 = Math.max(...[...history.values()].map((b) => b[b.length - 1]!.t));
console.log(`样本：${symbols.length} 标的 · ${new Date(t0).toISOString()} ~ ${new Date(t1).toISOString()}`);

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

// ============ 策略状态 ============

interface OpenPos {
  symbol: string;
  side: 'LONG' | 'SHORT';
  margin: number;
  qty: number;
  entryPrice: number;
  liqPrice: number;
  entryTs: number;
  cycleId: string;
  openSlip: number;
  volRegime: string;
  confirmCostPct: number;
  peakPnl: number;
}

interface ClosedTrade {
  symbol: string; side: string; entryTs: number; exitTs: number; holdBars: number;
  netPnlWithSlip: number; netPnl: number; fees: number; slippage: number;
  exitReason: string; volRegime: string; confirmCostPct: number; liq: boolean;
}

interface PolicyState {
  name: string;
  balance: number;
  positions: OpenPos[];
  trades: ClosedTrade[];
  uteStates: Map<string, TrendState>;
  lifecycles: Map<string, ReturnType<typeof createLifecycleState>>;
  /** 已开仓的周期（幂等：同一周期不重复开仓） */
  tradedCycles: Set<string>;
  equityPeak: number;
  maxDrawdown: number;
  /** 指标采集 */
  confirmCosts: number[]; // 确认时刻已走收益 %
  falseConfirms: number;  // 确认后 15 根内净亏离场
  confirmCounts: number;
}

function newState(name: string): PolicyState {
  return {
    name, balance: CAPITAL, positions: [], trades: [],
    uteStates: new Map(), lifecycles: new Map(), tradedCycles: new Set(),
    equityPeak: CAPITAL, maxDrawdown: 0,
    confirmCosts: [], falseConfirms: 0, confirmCounts: 0,
  };
}

const v1 = newState('v1(Task53基线)');
const v2 = newState('v2(Task54改进)');
const v2h = newState('v2h(+15m方向门控)');

// ============ 执行辅助 ============

const barAt = (symbol: string, openT: number): Bar | undefined => {
  const bars = history.get(symbol)!;
  // bars[t] 以开盘时间索引（二分）
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t === openT) return bars[mid];
    if (bars[mid]!.t < openT) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
};

function openPosition(
  st: PolicyState, symbol: string, side: 'LONG' | 'SHORT', fill: Bar, cycleId: string,
  volRegime: string, confirmCostPct: number, now: number,
): void {
  const marks = st.positions.reduce((s, p) => s + p.margin, 0);
  const equity = st.balance + marks; // 开仓前无未实现（逐分钟结算）
  const margin = Math.floor(equity * TREND_TRADE_MARGIN_RATIO * 100) / 100;
  const fee = margin * LEVERAGE * TAKER_FEE;
  if (margin < 2 || margin + fee > st.balance) return; // 与生产一致：保证金不足跳过
  const notional = margin * LEVERAGE;
  const qty = notional / fill.o;
  const openSlip = notional * (SLIP_BPS / 10_000);
  st.balance -= margin + fee;
  st.positions.push({
    symbol, side, margin, qty,
    entryPrice: fill.o,
    liqPrice: liqPriceFor({ symbol, side, entry: fill.o, leverage: LEVERAGE, notional }),
    entryTs: now, cycleId, openSlip, volRegime, confirmCostPct,
    peakPnl: 0,
  });
  st.confirmCosts.push(confirmCostPct);
  st.confirmCounts++;
}

function closePosition(
  st: PolicyState, p: OpenPos, fillPrice: number, now: number, reason: string, liq = false,
): void {
  const sign = p.side === 'LONG' ? 1 : -1;
  const gross = (fillPrice - p.entryPrice) * p.qty * sign;
  const closeFee = fillPrice * p.qty * TAKER_FEE;
  const closeSlip = fillPrice * p.qty * (SLIP_BPS / 10_000);
  const netPnl = gross - closeFee - p.openSlip; // 与生产 PaperEngine 口径一致（净盈亏扣双边费）
  const netWithSlip = netPnl - closeSlip;
  st.balance += p.margin + gross - closeFee;
  st.positions = st.positions.filter((x) => x !== p);
  st.trades.push({
    symbol: p.symbol, side: p.side, entryTs: p.entryTs, exitTs: now,
    holdBars: Math.round((now - p.entryTs) / INTERVAL_MS),
    netPnlWithSlip: netWithSlip, netPnl, fees: p.entryPrice * p.qty * TAKER_FEE + closeFee,
    slippage: p.openSlip + closeSlip,
    exitReason: reason, volRegime: p.volRegime, confirmCostPct: p.confirmCostPct, liq,
  });
  if (netWithSlip < 0 && now - p.entryTs <= 15 * INTERVAL_MS) st.falseConfirms++;
}

const TREND_TRADE_MARGIN_RATIO = 0.2;
const LEVERAGE = 20;
const SLIP_BPS = 2;

function checkLiquidation(st: PolicyState, mark: number, symbol: string): void {
  for (const p of [...st.positions]) {
    if (p.symbol !== symbol) continue;
    const hit = p.side === 'LONG' ? mark <= p.liqPrice : mark >= p.liqPrice;
    if (hit) closePosition(st, p, p.liqPrice, Date.now(), 'LIQUIDATED', true);
  }
}

// ============ 主循环（逐分钟、严格时序） ============

const warmupBars = 480;
const startT = t0 + warmupBars * INTERVAL_MS;
let tradesFeed = 0;

for (let T = startT; T <= t1; T += INTERVAL_MS) {
  for (const symbol of symbols) {
    const bars = history.get(symbol)!;
    // 本分钟刚收盘的 1m bar：open time = T - 60s
    const closedBar = barAt(symbol, T - INTERVAL_MS);
    if (!closedBar) continue;
    tradesFeed++;

    // —— 组装 480 根已收盘窗口（UTE WatchOhlcvSeries）——
    const idx = bars.indexOf(closedBar);
    const win = bars.slice(Math.max(0, idx - warmupBars + 1), idx + 1);
    const series: WatchOhlcvSeries = {
      symbol,
      barMs: win.map((b) => b.t),
      opens: win.map((b) => b.o),
      highs: win.map((b) => b.h),
      lows: win.map((b) => b.l),
      closes: win.map((b) => b.c),
      vols: win.map((b) => b.qv),
    };

    // —— 共同输入：UTE 评估（方向唯一来源）+ 特征 + 生命周期 ——
    const v1res = scanAnomalyCandidates([{ series, anomalyFlag: false }], v1.uteStates, T, trendCfg, INTERVAL_MS);
    const v1sig = v1res.signals.find((s) => s.symbol === symbol)!;
    v1.uteStates = v1res.states;

    const v2res = scanAnomalyCandidates([{ series, anomalyFlag: false }], v2.uteStates, T, trendCfg, INTERVAL_MS);
    const v2sig = v2res.signals.find((s) => s.symbol === symbol)!;
    v2.uteStates = v2res.states;

    const v2hres = scanAnomalyCandidates([{ series, anomalyFlag: false }], v2h.uteStates, T, trendCfg, INTERVAL_MS);
    const v2hsig = v2hres.signals.find((s) => s.symbol === symbol)!;
    v2h.uteStates = v2hres.states;

    const closed = toClosedBars(series, INTERVAL_MS, T);
    const features = computeVolatilityFeatures(closed, DEFAULT_INDICATOR_CFG);
    const htfCfg = { lookbackBars: TREND_WATCH.lookbackBars, minMovePct: TREND_WATCH.minMovePct };
    const htf15m = assessHtf(closed, 15, T, htfCfg, (bs, opts) => assessTrend(bs, opts, trendCfg));
    const lastBarTime = v2sig.assessment.features?.latestBarTime ?? null;
    const stale = lastBarTime != null && T - (lastBarTime + INTERVAL_MS) > TREND_WATCH.KLINE_STALE_MS;
    const dataOk = !stale && v2sig.assessment.eligible && v2sig.assessment.features != null;
    const strength = Math.max(0, Math.min(1, Math.abs(v2sig.assessment.features?.returnPct ?? 0) / (TREND_WATCH.minMovePct * 3)));

    const mkLc = (st: PolicyState, sigv: TrendState) => {
      const l = st.lifecycles.get(symbol) ?? createLifecycleState(symbol);
      const r = stepLifecycle(l, {
        utePhase: sigv.phase,
        uteDirection: sigv.direction,
        uteCandidateDirection: sigv.candidateDirection,
        directionalConsistency: sigv.assessment.features?.directionalConsistency ?? 0,
        returnPct: sigv.assessment.features?.returnPct ?? 0,
        barTime: lastBarTime,
        uteChangedAt: sigv.changedAt,
        uteConfirmCount: sigv.consecutiveObservations,
        uteScore: sigv.lastScore,
        strength,
        features: dataOk ? features : null,
        dataOk,
        now: T,
      });
      st.lifecycles.set(symbol, r.state); // 状态机产出为新对象：写回（与生产同纪律）
      return r;
    };
    const lcRes = mkLc(v2, v2sig);
    const lcResH = mkLc(v2h, v2hsig);

    // —— 强平检查（逐分钟 mark = 本分钟收盘价）——
    for (const st of [v1, v2, v2h]) checkLiquidation(st, closedBar.c, symbol);

    // —— v1 退出：UTE 离开 confirmed ——
    for (const p of [...v1.positions]) {
      if (p.symbol !== symbol) continue;
      const s = v1sig;
      const stillConfirmed = s.phase === 'confirmed' && s.direction === (p.side === 'LONG' ? 'up' : 'down');
      if (!stillConfirmed) {
        const fill = barAt(symbol, T);
        if (fill) closePosition(v1, p, fill.o, T, 'UTE_LEFT_CONFIRMED');
      }
    }
    // —— v1 开仓：UTE 刚确认（changedAt 更新且未交易过）——
    if (v1sig.phase === 'confirmed' && v1sig.direction !== 'flat') {
      const cycleId = `${symbol}:${v1sig.direction}:${v1sig.changedAt}`;
      if (!v1.tradedCycles.has(cycleId) && v1.positions.length < MAXPOS && v1.positions.every((p) => p.symbol !== symbol)) {
        const fill = barAt(symbol, T);
        if (fill) {
          v1.tradedCycles.add(cycleId);
          openPosition(v1, symbol, v1sig.direction === 'up' ? 'LONG' : 'SHORT', fill, cycleId, features.volRegime, Math.abs(v1sig.assessment.features?.returnPct ?? 0), T);
        }
      }
    }

    // —— v2 / v2h 退出：lifecycle ENDED（对应周期）——
    for (const [st, lcr] of [[v2, lcRes], [v2h, lcResH]] as const) {
      for (const p of [...st.positions]) {
        if (p.symbol !== symbol) continue;
        if (lcr.state.phase === 'ENDED' && lcr.state.cycleId === p.cycleId) {
          const fill = barAt(symbol, T);
          if (fill) closePosition(st, p, fill.o, T, `ENDED:${lcr.state.endReason}`);
        }
      }
    }
    // —— v2 开仓：lifecycle CONFIRMED_*（数据新鲜）——
    if ((lcRes.state.phase === 'CONFIRMED_UP' || lcRes.state.phase === 'CONFIRMED_DOWN') && dataOk) {
      const side = lcRes.state.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';
      const cycleId = lcRes.state.cycleId!;
      if (!v2.tradedCycles.has(cycleId) && v2.positions.length < MAXPOS && v2.positions.every((p) => p.symbol !== symbol)) {
        const fill = barAt(symbol, T);
        if (fill) {
          v2.tradedCycles.add(cycleId);
          openPosition(v2, symbol, side, fill, cycleId, features.volRegime, Math.abs(v2sig.assessment.features?.returnPct ?? 0), T);
        }
      }
    }
    // —— v2h 开仓：v2 门槛 + 15m 高周期方向一致（校准方向实验，未验证）——
    if ((lcResH.state.phase === 'CONFIRMED_UP' || lcResH.state.phase === 'CONFIRMED_DOWN') && dataOk) {
      const side = lcResH.state.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';
      const dirOk = htf15m.valid && htf15m.dir === (side === 'LONG' ? 'up' : 'down');
      const cycleId = lcResH.state.cycleId!;
      if (dirOk && !v2h.tradedCycles.has(cycleId) && v2h.positions.length < MAXPOS && v2h.positions.every((p) => p.symbol !== symbol)) {
        const fill = barAt(symbol, T);
        if (fill) {
          v2h.tradedCycles.add(cycleId);
          openPosition(v2h, symbol, side, fill, cycleId, features.volRegime, Math.abs(v2hsig.assessment.features?.returnPct ?? 0), T);
        }
      }
    }

    // —— 权益曲线（逐分钟）——
    for (const st of [v1, v2, v2h]) {
      let unreal = 0;
      for (const p of st.positions) {
        if (p.symbol !== symbol) continue;
        unreal += (closedBar.c - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
      }
      // 累计到分钟级权益（其余 symbol 的未实现已在前一分钟的循环中累计——简化：仅取已实现+全仓 mark 重估在汇总时做）
      void unreal;
    }
  }
  // 每分钟末统一按最新收盘重估权益（简化：用各 symbol 最近收盘价）
  for (const st of [v1, v2, v2h]) {
    let unreal = 0;
    for (const p of st.positions) {
      const bars = history.get(p.symbol)!;
      const last = bars.findLast?.((b) => b.t <= T) ?? bars[bars.length - 1]!;
      unreal += (last.c - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
    }
    const equity = st.balance + st.positions.reduce((s, p) => s + p.margin, 0) + unreal;
    st.equityPeak = Math.max(st.equityPeak, equity);
    st.maxDrawdown = Math.max(st.maxDrawdown, st.equityPeak > 0 ? (st.equityPeak - equity) / st.equityPeak : 0);
  }
}

// ============ 报告 ============

function report(st: PolicyState) {
  const closed = st.trades;
  const net = closed.reduce((s, t) => s + t.netPnlWithSlip, 0);
  const fees = closed.reduce((s, t) => s + t.fees, 0);
  const slips = closed.reduce((s, t) => s + t.slippage, 0);
  const wins = closed.filter((t) => t.netPnlWithSlip > 0).length;
  const liqs = closed.filter((t) => t.liq).length;
  const avgHold = closed.length ? closed.reduce((s, t) => s + t.holdBars, 0) / closed.length : 0;
  const avgCost = st.confirmCosts.length ? st.confirmCosts.reduce((s, v) => s + v, 0) / st.confirmCosts.length : 0;
  const falseRate = st.confirmCounts ? (st.falseConfirms / st.confirmCounts) * 100 : 0;
  const endReasons: Record<string, number> = {};
  for (const t of closed) endReasons[t.exitReason] = (endReasons[t.exitReason] ?? 0) + 1;
  // 按波动状态分桶
  const byRegime: Record<string, { n: number; net: number }> = {};
  for (const t of closed) {
    byRegime[t.volRegime] ??= { n: 0, net: 0 };
    byRegime[t.volRegime]!.n++;
    byRegime[t.volRegime]!.net += t.netPnlWithSlip;
  }
  return { net, fees, slips, wins, liqs, avgHold, avgCost, falseRate, endReasons, byRegime, count: closed.length };
}

const r1 = report(v1);
const r2 = report(v2);
const r2h = report(v2h);
const lines: string[] = [];
lines.push('# 历史回放对比（v1 基线 vs v2 改进）');
lines.push('');
lines.push(`- 区间：${new Date(t0).toISOString()} ~ ${new Date(t1).toISOString()}（${((t1 - t0) / 3600_000).toFixed(0)} 小时，1m K 线）`);
lines.push(`- 样本：${symbols.join(', ')}`);
lines.push(`- 执行假设：下一根 1m 开盘价成交 · Taker 0.05% 双边 · 滑点 2bp 单边 · 20% 权益/笔 · 20x · 最多 ${MAXPOS} 仓 · 无止盈止损 · 逐仓强平公式`);
lines.push('- ⚠️ 样本内统计，未做多周期/多市场稳健性验证；不构成盈利能力证明');
lines.push('');
lines.push('| 指标 | v1 基线（Task53） | v2 改进（Task54） |');
lines.push('|---|---|---|');
lines.push(`| 交易笔数 | ${r1.count} | ${r2.count} |`);
lines.push(`| 净收益（含滑点）| ${r1.net.toFixed(2)} | ${r2.net.toFixed(2)} |`);
lines.push(`| 手续费合计 | ${r1.fees.toFixed(2)} | ${r2.fees.toFixed(2)} |`);
lines.push(`| 滑点合计 | ${r1.slips.toFixed(2)} | ${r2.slips.toFixed(2)} |`);
lines.push(`| 胜率 | ${r1.count ? ((r1.wins / r1.count) * 100).toFixed(1) : '—'}% | ${r2.count ? ((r2.wins / r2.count) * 100).toFixed(1) : '—'}% |`);
lines.push(`| 强平次数 | ${r1.liqs} | ${r2.liqs} |`);
lines.push(`| 平均持仓（根）| ${r1.avgHold.toFixed(0)} | ${r2.avgHold.toFixed(0)} |`);
lines.push(`| 确认时刻已走收益%（确认成本）| ${r1.avgCost.toFixed(2)}% | ${r2.avgCost.toFixed(2)}% |`);
lines.push(`| 假确认率（15 根内亏损离场）| ${r1.falseRate.toFixed(1)}% | ${r2.falseRate.toFixed(1)}% |`);
lines.push(`| 最大回撤 | ${(v1.maxDrawdown * 100).toFixed(1)}% | ${(v2.maxDrawdown * 100).toFixed(1)}% |`);
lines.push(`| 期末权益 | ${v1.balance.toFixed(2)} | ${v2.balance.toFixed(2)} |`);
lines.push('');
lines.push('## v2h 附加实验（v2 + 15m 高周期方向一致门控；校准方向，未经稳健性验证）');
lines.push('');
lines.push('| 指标 | v2h |');
lines.push('|---|---|');
lines.push(`| 交易笔数 | ${r2h.count} |`);
lines.push(`| 净收益（含滑点）| ${r2h.net.toFixed(2)} |`);
lines.push(`| 手续费 | ${r2h.fees.toFixed(2)} |`);
lines.push(`| 胜率 | ${r2h.count ? ((r2h.wins / r2h.count) * 100).toFixed(1) : '—'}% |`);
lines.push(`| 假确认率（15 根内亏损离场）| ${r2h.falseRate.toFixed(1)}% |`);
lines.push(`| 强平 | ${r2h.liqs} |`);
lines.push(`| 平均持仓（根）| ${r2h.avgHold.toFixed(0)} |`);
lines.push(`| 最大回撤 | ${(v2h.maxDrawdown * 100).toFixed(1)}% |`);
lines.push(`| 期末权益 | ${v2h.balance.toFixed(2)} |`);
lines.push('');
lines.push(`v2h 平仓原因分布：${JSON.stringify(r2h.endReasons)}`);
lines.push('');
lines.push(`v2h 按波动状态分桶：${JSON.stringify(r2h.byRegime)}`);
lines.push('');
lines.push(`v1 平仓原因分布：${JSON.stringify(r1.endReasons)}`);
lines.push('');
lines.push(`v2 平仓原因分布：${JSON.stringify(r2.endReasons)}`);
lines.push('');
lines.push(`v2 按波动状态分桶：${JSON.stringify(r2.byRegime)}`);
const out = lines.join('\n');
console.log(out);
writeFileSync('/home/z/my-project/scripts/replay/report.md', out + '\n');
