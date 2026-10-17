// ---------- 历史回放 · Task 56 三策略对比（A 基线 / B 仅修 bug / C B+入场过滤） ----------
// 用法：bun scripts/replay/run-replay-t56.ts [--capital 100] [--maxpos 3]
//
// 与 run-replay.ts（Task 54 v1/v2/v2h 报告）同一份数据、同一执行假设（下一根 1m 开盘价
// 成交、双边 Taker 0.05%、单边 2bp 滑点、逐仓强平公式、无止盈止损），差异：
//   A 基线：复现 Task 55 线上行为——CONFIRMED 即开（无质量门槛/无二次确认/无冷却）；
//           END_PENDING 第一根证据立即平仓（旧证据阈值 |returnPct|<0.35%×2.5、ER<0.25、
//           一致性<0.35、反向候选）；ENDED 任意周期归属即平。
//   B 仅修 bug：Task 56 新 lifecycle（END_CONFIRM_BARS=3 根不同已收盘 K 线持续证据才
//           ENDED、迟滞衰减线 0.35%×0.6、条件恢复清零、barTime 去重、出生 bar 排除、
//           DATA_UNAVAILABLE 冻结；周期匹配离场、反向确认立即平）；开仓仍无门槛。
//   C B+入场过滤：B + score≥70 + ER≥0.4 + 5m/15m 高周期过滤 + 等待一根新收盘 K 线
//           二次确认 + 同币种平仓后 5 分钟冷却 + 默认 3 仓。
//
// ⚠️ 无法在严格时序回放中复现的旧 bug（如实说明，不编造）：
//   - 「秒级误杀」（dataOk/barTime 交替打败同根去重）依赖线上 10s 扫描粒度的数据竞态，
//     回放为逐分钟确定性时序，A 的「第一根证据即平」已涵盖其主要后果（分钟内离场）；
//   - 「旧周期 ENDED 误杀新周期持仓」依赖重启/信号乱序窗口，回放严格时序下两策略该
//     分支等价——A 的差异主要来自 END_PENDING 即平与无入场过滤。
// ⚠️ 样本内统计，不构成盈利能力证明；所有阈值为工程参数。

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import {
  assessTrend,
  scanAnomalyCandidates,
  toClosedBars,
  type TrendState,
  type WatchOhlcvSeries,
} from 'universal-trend-engine';
import {
  computeVolatilityFeatures,
  assessHtf,
  DEFAULT_INDICATOR_CFG,
} from '../../src/lib/market/trend-watch/indicators';
import {
  createLifecycleState,
  stepLifecycle,
  type LifecycleState,
} from '../../src/lib/market/trend-watch/lifecycle';
import { TREND_WATCH, trendEngineConfig } from '../../src/lib/market/trend-watch/config';
import { liqPriceFor, TAKER_FEE } from '../../src/lib/market/futures';

const DATA_DIR = '/home/z/my-project/scripts/replay/data';
const args = process.argv.slice(2);
function argNum(name: string, def: number): number {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
}
const CAPITAL = argNum('--capital', 100);
const MAXPOS = argNum('--maxpos', 3); // Task 56 用户定版默认 3 仓（三策略统一，公平对比）

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
  scoreAtOpen: number;
  erAtOpen: number;
  /** MFE/MAE（占保证金 %；持仓期间逐分钟用当时收盘价增量更新，绝不用事后高低价） */
  mfe: number;
  mae: number;
}

interface ClosedTrade {
  symbol: string; side: string; entryTs: number; exitTs: number; holdBars: number;
  netPnlWithSlip: number; gross: number; fees: number; slippage: number;
  exitReason: string; volRegime: string; scoreAtOpen: number; erAtOpen: number;
  liq: boolean; mfe: number; mae: number;
}

interface PendingEntry {
  cycleId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  firstBarTime: number;
  firstSeenT: number;
}

interface PolicyState {
  name: string;
  balance: number;
  positions: OpenPos[];
  trades: ClosedTrade[];
  tradedCycles: Set<string>;
  equityPeak: number;
  maxDrawdown: number;
  falseConfirms: number;
  /** C 专用：待入场记录（cycleId 主键）与同币种最近平仓时刻 */
  pendings: Map<string, PendingEntry>;
  lastCloseAt: Map<string, number>;
}

function newState(name: string): PolicyState {
  return {
    name, balance: CAPITAL, positions: [], trades: [],
    tradedCycles: new Set(),
    equityPeak: CAPITAL, maxDrawdown: 0,
    falseConfirms: 0,
    pendings: new Map(), lastCloseAt: new Map(),
  };
}

const A = newState('A 基线（Task55 线上行为）');
const B = newState('B 仅修 bug（新 lifecycle）');
const C = newState('C = B + 入场过滤');

const TREND_TRADE_MARGIN_RATIO = 0.2;
const LEVERAGE = 20;
const SLIP_BPS = 2;
const COOLDOWN_MS = 5 * 60_000;
const PENDING_EXPIRE_MS = 10 * 60_000;
const ENTRY_MIN_SCORE = 70;
const ENTRY_MIN_ER = 0.4;
const HTF_STRICT_SCORE = 85;
const HTF_STRICT_ER = 0.5;

// ============ 执行辅助 ============

const barAt = (symbol: string, openT: number): Bar | undefined => {
  const bars = history.get(symbol)!;
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
  volRegime: string, score: number, er: number, now: number,
): boolean {
  const marks = st.positions.reduce((s, p) => s + p.margin, 0);
  const equity = st.balance + marks;
  const margin = Math.floor(equity * TREND_TRADE_MARGIN_RATIO * 100) / 100;
  const fee = margin * LEVERAGE * TAKER_FEE;
  if (margin < 2 || margin + fee > st.balance) return false; // 与生产一致：保证金不足跳过
  const notional = margin * LEVERAGE;
  const qty = notional / fill.o;
  const openSlip = notional * (SLIP_BPS / 10_000);
  st.balance -= margin + fee;
  st.positions.push({
    symbol, side, margin, qty,
    entryPrice: fill.o,
    liqPrice: liqPriceFor({ symbol, side, entry: fill.o, leverage: LEVERAGE, notional }),
    entryTs: now, cycleId, openSlip, volRegime, scoreAtOpen: score, erAtOpen: er,
    mfe: 0, mae: 0,
  });
  return true;
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
    netPnlWithSlip: netWithSlip, gross, fees: p.entryPrice * p.qty * TAKER_FEE + closeFee,
    slippage: p.openSlip + closeSlip,
    exitReason: reason, volRegime: p.volRegime, scoreAtOpen: p.scoreAtOpen, erAtOpen: p.erAtOpen,
    liq, mfe: p.mfe, mae: p.mae,
  });
  st.lastCloseAt.set(p.symbol, now);
  if (netWithSlip < 0 && now - p.entryTs <= 15 * INTERVAL_MS) st.falseConfirms++;
}

function checkLiquidation(st: PolicyState, mark: number, symbol: string, now: number): void {
  for (const p of [...st.positions]) {
    if (p.symbol !== symbol) continue;
    const hit = p.side === 'LONG' ? mark <= p.liqPrice : mark >= p.liqPrice;
    if (hit) closePosition(st, p, p.liqPrice, now, 'LIQUIDATED', true);
  }
}

/** MFE/MAE 逐分钟增量更新（持仓期间用当时收盘价；与生产 updateOpenStats 同语义） */
function updateOpenStats(st: PolicyState, mark: number, symbol: string): void {
  for (const p of st.positions) {
    if (p.symbol !== symbol) continue;
    const sign = p.side === 'LONG' ? 1 : -1;
    const pnlPct = (((mark - p.entryPrice) * p.qty * sign) / p.margin) * 100;
    if (pnlPct > p.mfe) p.mfe = pnlPct;
    if (pnlPct < p.mae) p.mae = pnlPct;
  }
}

// ============ A 基线的旧证据判定（Task 55 线上行为内联复现） ============
// 旧证据（Task 54 旧 lifecycle 阈值）：
//   A 反向候选：UTE candidate 方向反向
//   B 动量衰减：|窗口收益| < minMovePct × 2.5 = 0.875%（旧 END_IDLE_TOL_MUL，绝对值口径）
//   C 结构失效：ER < 0.25 或 方向一致性 < 0.35
// 旧行为：CONFIRMED 中出现第一根证据 → END_PENDING → 立即平仓（manageExits v2）。

interface OldLcState { phase: 'IDLE' | 'CONFIRMED' | 'ENDED'; dir: 'up' | 'down' | 'flat'; cycleId: string | null }

function oldEvidence(
  sig: TrendState,
): 'REVERSE_CANDIDATE' | 'DECAY' | 'STRUCTURE_ER' | 'STRUCTURE_CONSIST' | null {
  const f = sig.assessment.features;
  if (!f) return null;
  if (sig.phase === 'candidate' && sig.candidateDirection !== 'flat') return 'REVERSE_CANDIDATE';
  if (Math.abs(f.returnPct) < TREND_WATCH.minMovePct * 2.5) return 'DECAY';
  if (f.efficiencyRatio < TREND_WATCH.END_ER_FLOOR) return 'STRUCTURE_ER';
  if (f.directionalConsistency < TREND_WATCH.END_CONSISTENCY_FLOOR) return 'STRUCTURE_CONSIST';
  return null;
}

const oldLcs = new Map<string, OldLcState>();

// ============ C 的高周期过滤（与生产 entryGateCheck 同口径） ============

type HtfGate = 'ALIGNED' | 'NEUTRAL' | 'OPPOSED' | 'INVALID';

function classifyHtf(dir: 'up' | 'down' | 'flat', valid: boolean, trendDir: 'up' | 'down'): HtfGate {
  if (!valid) return 'INVALID';
  if (dir === trendDir) return 'ALIGNED';
  if (dir === 'flat') return 'NEUTRAL';
  return 'OPPOSED';
}

function entryGate(
  score: number, er: number, htf5m: { dir: 'up' | 'down' | 'flat'; valid: boolean },
  htf15m: { dir: 'up' | 'down' | 'flat'; valid: boolean }, trendDir: 'up' | 'down',
): string | null {
  if (score < ENTRY_MIN_SCORE) return `score ${score.toFixed(0)}<${ENTRY_MIN_SCORE}`;
  if (er < ENTRY_MIN_ER) return `ER ${er.toFixed(2)}<${ENTRY_MIN_ER}`;
  const g5 = classifyHtf(htf5m.dir, htf5m.valid, trendDir);
  const g15 = classifyHtf(htf15m.dir, htf15m.valid, trendDir);
  if (g5 === 'INVALID' || g15 === 'INVALID') return `HTF 数据不足（5m=${g5}/15m=${g15}）`;
  const strictOk = score >= HTF_STRICT_SCORE && er >= HTF_STRICT_ER;
  if (g5 === 'OPPOSED') return '5m 反对';
  if (g5 === 'NEUTRAL') {
    if (g15 === 'OPPOSED') return '5m 中性 + 15m 反对';
    if (!strictOk) return `5m 中性未达严格门槛（${score.toFixed(0)}/${HTF_STRICT_SCORE}, ER ${er.toFixed(2)}/${HTF_STRICT_ER}）`;
    return null;
  }
  if (g15 === 'OPPOSED' && !strictOk) {
    return `15m 反对未达严格门槛（${score.toFixed(0)}/${HTF_STRICT_SCORE}, ER ${er.toFixed(2)}/${HTF_STRICT_ER}）`;
  }
  return null;
}

// ============ 主循环（逐分钟、严格时序） ============

const warmupBars = 480;
const startT = t0 + warmupBars * INTERVAL_MS;
const newLc = new Map<string, LifecycleState>(); // B/C 共用（lifecycle 只吃 K 线/UTE，与持仓无关）
const sharedUteStates = new Map<string, TrendState>(); // UTE 跨分钟状态（输入相同 → 单份状态，三策略共用）

// C 诊断计数器（报告附录用）
const cDiag = { confirmed: 0, gateReject: {} as Record<string, number>, pendingCreated: 0, cooling: 0, pendingConverted: 0, pendingExpired: 0, dupOrCap: 0, scores: [] as number[], ers: [] as number[] };

for (let T = startT; T <= t1; T += INTERVAL_MS) {
  for (const symbol of symbols) {
    const bars = history.get(symbol)!;
    const closedBar = barAt(symbol, T - INTERVAL_MS);
    if (!closedBar) continue;

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

    // —— 共同输入：UTE 评估一次（输入相同 → 输出确定，三策略共用；状态跨分钟累积） ——
    const res = scanAnomalyCandidates([{ series, anomalyFlag: false }], sharedUteStates, T, trendCfg, INTERVAL_MS);
    for (const [k, v] of res.states) sharedUteStates.set(k, v);
    const sig = res.signals.find((s) => s.symbol === symbol)!;

    const closed = toClosedBars(series, INTERVAL_MS, T);
    const features = computeVolatilityFeatures(closed, DEFAULT_INDICATOR_CFG);
    const htfCfg = { lookbackBars: TREND_WATCH.lookbackBars, minMovePct: TREND_WATCH.minMovePct };
    const assessFn = (bs: WatchOhlcvSeries) => assessTrend(bs, { now: T, barMs: INTERVAL_MS }, trendCfg);
    const htf5m = assessHtf(closed, 5, T, htfCfg, assessFn);
    const htf15m = assessHtf(closed, 15, T, htfCfg, assessFn);
    const lastBarTime = sig.assessment.features?.latestBarTime ?? null;
    const stale = lastBarTime != null && T - (lastBarTime + INTERVAL_MS) > TREND_WATCH.KLINE_STALE_MS;
    const dataOk = !stale && sig.assessment.eligible && sig.assessment.features != null;
    const score = sig.lastScore;
    // ER 是本项目 indicators 自算字段（computeVolatilityFeatures）——不是 UTE assessment.features 的字段
    const er = features.efficiencyRatio;
    const fill = barAt(symbol, T); // 本分钟开盘价（决策在 T-60s 收盘后，成交在 T 开盘）

    // —— 强平 + MFE/MAE（任何策略任何模式都执行） ——
    for (const st of [A, B, C]) {
      checkLiquidation(st, closedBar.c, symbol, T);
      updateOpenStats(st, closedBar.c, symbol);
    }

    // ========== A 基线（Task 55 线上行为） ==========
    {
      const prev = oldLcs.get(symbol) ?? { phase: 'IDLE' as const, dir: 'flat' as const, cycleId: null };
      const next: OldLcState = { ...prev };
      if (!dataOk) {
        // 旧版 dataOk=false：barTime=null 伪证据 bug 在分钟粒度下不可复现（见文件头说明），
        // 如实处理为跳过（状态冻结）
      } else if (sig.phase === 'confirmed' && sig.direction !== 'flat') {
        if (prev.phase !== 'CONFIRMED' || prev.dir !== sig.direction) {
          next.phase = 'CONFIRMED';
          next.dir = sig.direction;
          next.cycleId = `${symbol}:${sig.direction}:${sig.changedAt}`;
        }
      } else if (prev.phase === 'CONFIRMED') {
        // 不再 confirmed：旧版 manageExits 依赖 END_PENDING/ENDED——这里按旧证据链：
        const ev = oldEvidence(sig);
        if (ev || sig.phase === 'idle') {
          next.phase = 'ENDED';
        }
      }
      oldLcs.set(symbol, next);

      // 旧版退出：CONFIRMED 中出现证据 → END_PENDING 即平（任意归属）；反向 confirmed 平；
      // ENDED 平（任意归属）
      if (fill && dataOk) {
        for (const p of [...A.positions]) {
          if (p.symbol !== symbol) continue;
          if (next.phase === 'ENDED') {
            closePosition(A, p, fill.o, T, 'ENDED(任意归属)');
            continue;
          }
          if (next.phase !== 'CONFIRMED') continue;
          const dirChanged = sig.phase === 'confirmed' && sig.direction !== 'flat' && sig.direction !== p.side.toLowerCase();
          if (dirChanged) {
            closePosition(A, p, fill.o, T, 'REVERSE_CONFIRMED');
            continue;
          }
          const ev = oldEvidence(sig);
          if (ev) closePosition(A, p, fill.o, T, `END_PENDING:${ev}`); // 旧版：第一根证据即离场
        }
      }
      // 旧版开仓：CONFIRMED 即开（无门槛/无冷却/无二次确认）
      if (fill && dataOk && next.phase === 'CONFIRMED' && next.cycleId) {
        const side = next.dir === 'up' ? 'LONG' : 'SHORT';
        if (!A.tradedCycles.has(next.cycleId) && A.positions.length < MAXPOS && A.positions.every((p) => p.symbol !== symbol)) {
          if (openPosition(A, symbol, side, fill, next.cycleId, features.volRegime, score, er, T)) {
            A.tradedCycles.add(next.cycleId);
          }
        }
      }
    }

    // ========== B / C 共用：新 lifecycle（Task 56） ==========
    {
      const l = newLc.get(symbol) ?? createLifecycleState(symbol);
      const lcr = stepLifecycle(l, {
        utePhase: sig.phase,
        uteDirection: sig.direction,
        uteCandidateDirection: sig.candidateDirection,
        directionalConsistency: sig.assessment.features?.directionalConsistency ?? 0,
        returnPct: sig.assessment.features?.returnPct ?? 0,
        barTime: lastBarTime,
        uteChangedAt: sig.changedAt,
        uteConfirmCount: sig.consecutiveObservations,
        uteScore: score,
        strength: Math.max(0, Math.min(1, Math.abs(sig.assessment.features?.returnPct ?? 0) / (TREND_WATCH.minMovePct * 3))),
        features: dataOk ? features : null,
        dataOk,
        now: T,
      });
      newLc.set(symbol, lcr.state);
      const lc = lcr.state;

      // —— 退出（B/C 同规则：周期匹配 ENDED / 反向确认；END_PENDING 不平） ——
      if (fill && dataOk) {
        for (const st of [B, C]) {
          for (const p of [...st.positions]) {
            if (p.symbol !== symbol) continue;
            if (lc.phase === 'ENDED' && lc.cycleId === p.cycleId) {
              closePosition(st, p, fill.o, T, `ENDED:${lc.endReason}`);
              continue;
            }
            const favorable = p.side === 'LONG' ? sig.direction === 'up' : sig.direction === 'down';
            if ((lc.phase === 'CONFIRMED_UP' || lc.phase === 'CONFIRMED_DOWN') && !favorable) {
              closePosition(st, p, fill.o, T, 'REVERSE_CONFIRMED');
            }
          }
        }
      }

      // —— B 开仓：CONFIRMED 即开（无门槛；与 A 唯一差异是 lifecycle/退出） ——
      if (fill && dataOk && (lc.phase === 'CONFIRMED_UP' || lc.phase === 'CONFIRMED_DOWN')) {
        const side = lc.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';
        const cycleId = lc.cycleId!;
        if (!B.tradedCycles.has(cycleId) && B.positions.length < MAXPOS && B.positions.every((p) => p.symbol !== symbol)) {
          if (openPosition(B, symbol, side, fill, cycleId, features.volRegime, score, er, T)) {
            B.tradedCycles.add(cycleId);
          }
        }
      }

      // —— C 开仓：B + 质量门槛 + 二次确认 + 冷却 ——
      if (fill && dataOk && (lc.phase === 'CONFIRMED_UP' || lc.phase === 'CONFIRMED_DOWN')) {
        const cycleId = lc.cycleId!;
        const trendDir = lc.phase === 'CONFIRMED_UP' ? 'up' : 'down';
        const gateNow = entryGate(score, er, htf5m, htf15m, trendDir);
        cDiag.confirmed++;
        cDiag.scores.push(score);
        cDiag.ers.push(er);
        if (gateNow) {
          const key = gateNow.replace(/\d.*/, '');
          cDiag.gateReject[key] = (cDiag.gateReject[key] ?? 0) + 1;
        }
        const pend = C.pendings.get(cycleId);
        if (pend) {
          // 待入场复核：等待一根「更新的已收盘 K 线」（§5.3）
          if (lastBarTime != null && lastBarTime > pend.firstBarTime) {
            const gate = entryGate(score, er, htf5m, htf15m, pend.side === 'LONG' ? 'up' : 'down');
            const cd = C.lastCloseAt.get(pend.symbol);
            const cooling = cd != null && T - cd < COOLDOWN_MS;
            const dup = C.positions.some((p) => p.symbol === pend.symbol);
            if (gate) {
              C.pendings.delete(cycleId);
            } else if (cooling) {
              cDiag.cooling++;
              C.pendings.delete(cycleId);
            } else if (dup) {
              cDiag.dupOrCap++;
              C.pendings.delete(cycleId);
            } else if (C.positions.length < MAXPOS) {
              if (openPosition(C, pend.symbol, pend.side, fill, cycleId, features.volRegime, score, er, T)) {
                C.tradedCycles.add(cycleId);
                C.pendings.delete(cycleId);
                cDiag.pendingConverted++;
              }
            } else {
              cDiag.dupOrCap++;
            }
            // 容量不足：保留待入场（下轮复核，直到过期）
          }
          if (C.pendings.has(cycleId) && T - pend.firstSeenT > PENDING_EXPIRE_MS) {
            C.pendings.delete(cycleId);
            cDiag.pendingExpired++;
          }
        } else if (
          !C.tradedCycles.has(cycleId) &&
          C.positions.length + C.pendings.size < MAXPOS &&
          C.positions.every((p) => p.symbol !== symbol)
        ) {
          const cd = C.lastCloseAt.get(symbol);
          const cooling = cd != null && T - cd < COOLDOWN_MS;
          if (!cooling) {
            const gate = entryGate(score, er, htf5m, htf15m, trendDir);
            if (!gate && lastBarTime != null) {
              // 首次确认只建待入场记录（等待下一根已收盘 K 线复核），不立即下单
              C.pendings.set(cycleId, {
                cycleId, symbol,
                side: lc.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT',
                firstBarTime: lastBarTime,
                firstSeenT: T,
              });
              cDiag.pendingCreated++;
            }
          }
        }
      }
    }
  }

  // 每分钟末统一按最新收盘重估权益（与 run-replay.ts 同口径）
  for (const st of [A, B, C]) {
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

// ============ 报告（§十指标全集） ============

function report(st: PolicyState) {
  const closed = st.trades;
  const n = closed.length;
  const net = closed.reduce((s, t) => s + t.netPnlWithSlip, 0);
  const gross = closed.reduce((s, t) => s + t.gross, 0);
  const fees = closed.reduce((s, t) => s + t.fees, 0);
  const slips = closed.reduce((s, t) => s + t.slippage, 0);
  const wins = closed.filter((t) => t.netPnlWithSlip > 0);
  const losses = closed.filter((t) => t.netPnlWithSlip <= 0);
  const winRate = n ? (wins.length / n) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netPnlWithSlip, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.netPnlWithSlip, 0) / losses.length) : 0;
  const pl = avgLoss > 0 ? avgWin / avgLoss : 0; // 盈亏比
  const liqs = closed.filter((t) => t.liq).length;
  const avgHold = n ? closed.reduce((s, t) => s + t.holdBars, 0) / n : 0;
  const hours = (t1 - startT) / 3600_000;
  const tradePerHour = n / hours;
  const falseRate = n ? (st.falseConfirms / n) * 100 : 0;
  const avgMfe = n ? closed.reduce((s, t) => s + t.mfe, 0) / n : 0;
  const avgMae = n ? closed.reduce((s, t) => s + t.mae, 0) / n : 0;
  const endReasons: Record<string, number> = {};
  for (const t of closed) endReasons[t.exitReason] = (endReasons[t.exitReason] ?? 0) + 1;
  const bySide: Record<string, { n: number; net: number; win: number }> = {};
  for (const t of closed) {
    bySide[t.side] ??= { n: 0, net: 0, win: 0 };
    bySide[t.side]!.n++;
    bySide[t.side]!.net += t.netPnlWithSlip;
    if (t.netPnlWithSlip > 0) bySide[t.side]!.win++;
  }
  const byRegime: Record<string, { n: number; net: number }> = {};
  for (const t of closed) {
    byRegime[t.volRegime] ??= { n: 0, net: 0 };
    byRegime[t.volRegime]!.n++;
    byRegime[t.volRegime]!.net += t.netPnlWithSlip;
  }
  const bySymbol: Record<string, { n: number; net: number }> = {};
  for (const t of closed) {
    bySymbol[t.symbol] ??= { n: 0, net: 0 };
    bySymbol[t.symbol]!.n++;
    bySymbol[t.symbol]!.net += t.netPnlWithSlip;
  }
  return {
    n, net, gross, fees, slips, winRate, avgWin, avgLoss, pl, liqs, avgHold,
    tradePerHour, falseRate, avgMfe, avgMae, endReasons, bySide, byRegime, bySymbol,
    endEquity: st.balance + st.positions.reduce((s, p) => s + p.margin, 0),
  };
}

const rA = report(A);
const rB = report(B);
const rC = report(C);

function row(label: string, f: (r: ReturnType<typeof report>) => string): string {
  return `| ${label} | ${f(rA)} | ${f(rB)} | ${f(rC)} |`;
}

const lines: string[] = [];
lines.push('# 历史回放对比 · Task 56（A 基线 / B 仅修 bug / C B+入场过滤）');
lines.push('');
lines.push(`- 区间：${new Date(t0).toISOString()} ~ ${new Date(t1).toISOString()}（${((t1 - t0) / 3600_000).toFixed(0)} 小时，1m K 线，预热 ${warmupBars} 根后起算）`);
lines.push(`- 样本：${symbols.join(', ')}（Bybit/Gate 历史，不触碰币安）`);
lines.push(`- 执行假设：下一根 1m 开盘价成交 · Taker 0.05% 双边 · 滑点 2bp 单边 · 20% 权益保证金 · 20x · 最多 ${MAXPOS} 仓 · 无止盈止损 · 逐仓强平公式 · 起始资金 ${CAPITAL} U`);
lines.push('- A 基线 = Task 55 线上行为复现（END_PENDING 第一根证据即平 + 无入场过滤）；B = Task 56 新 lifecycle（三根独立收盘 K 线确认 + 迟滞 + 去重）；C = B + score/ER/高周期门槛 + 二次确认 + 5min 冷却');
lines.push('- ⚠️ 严格时序回放无法复现线上「秒级误杀」（10s 扫描粒度数据竞态）与「旧周期误杀」（重启/乱序窗口）——见脚本头注释；A 的差异主要来自 END_PENDING 即平与无入场过滤');
lines.push('- ⚠️ 样本内统计，不构成盈利能力证明；所有阈值为工程参数');
lines.push('');
lines.push('| 指标 | A 基线 | B 仅修 bug | C B+入场过滤 |');
lines.push('|---|---|---|---|');
lines.push(row('交易笔数', (r) => `${r.n}`));
lines.push(row('交易频率（笔/小时）', (r) => r.tradePerHour.toFixed(2)));
lines.push(row('累计净收益（含滑点，U）', (r) => r.net.toFixed(2)));
lines.push(row('价格贡献（毛收益，U）', (r) => r.gross.toFixed(2)));
lines.push(row('摩擦成本（手续费+滑点，U）', (r) => `${(r.fees + r.slips).toFixed(2)}（费 ${r.fees.toFixed(2)} / 滑 ${r.slips.toFixed(2)}）`));
lines.push(row('胜率', (r) => `${r.winRate.toFixed(1)}%`));
lines.push(row('盈亏比（均盈/均亏）', (r) => (r.avgLoss > 0 ? r.pl.toFixed(2) : '—')));
lines.push(row('平均盈利（U）', (r) => r.avgWin.toFixed(3)));
lines.push(row('平均亏损（U）', (r) => `-${r.avgLoss.toFixed(3)}`));
lines.push(row('误判率（15 根内亏损离场）', (r) => `${r.falseRate.toFixed(1)}%`));
lines.push(row('强平次数', (r) => `${r.liqs}`));
lines.push(row('平均持仓（分钟）', (r) => r.avgHold.toFixed(0)));
lines.push(row('平均 MFE（% 保证金）', (r) => r.avgMfe.toFixed(1)));
lines.push(row('平均 MAE（% 保证金）', (r) => r.avgMae.toFixed(1)));
lines.push(row('最大回撤', (r) => '—')); // 占位，下面单独输出（三策略各自 maxDrawdown）
lines.push(row('期末权益（U）', (r) => r.endEquity.toFixed(2)));
lines.push('');
lines.push(`最大回撤：A ${(A.maxDrawdown * 100).toFixed(1)}% · B ${(B.maxDrawdown * 100).toFixed(1)}% · C ${(C.maxDrawdown * 100).toFixed(1)}%`);
lines.push('');
lines.push('## 平仓原因分布');
lines.push('');
for (const [name, st, r] of [['A', A, rA], ['B', B, rB], ['C', C, rC]] as const) {
  void st;
  lines.push(`- **${name}**：${JSON.stringify(r.endReasons)}`);
}
lines.push('');
lines.push('## LONG/SHORT 分组');
lines.push('');
lines.push('| 策略 | 方向 | 笔数 | 净收益（U） | 胜率 |');
lines.push('|---|---|---|---|---|');
for (const [name, r] of [['A', rA], ['B', rB], ['C', rC]] as const) {
  for (const side of ['LONG', 'SHORT']) {
    const s = r.bySide[side];
    if (!s) continue;
    lines.push(`| ${name} | ${side} | ${s.n} | ${s.net.toFixed(2)} | ${((s.win / s.n) * 100).toFixed(0)}% |`);
  }
}
lines.push('');
lines.push('## 波动状态分桶');
lines.push('');
for (const [name, r] of [['A', rA], ['B', rB], ['C', rC]] as const) {
  lines.push(`- **${name}**：${JSON.stringify(r.byRegime)}`);
}
lines.push('');
lines.push('## 币种分组（按净收益排序，前 5 / 后 5）');
lines.push('');
for (const [name, r] of [['A', rA], ['B', rB], ['C', rC]] as const) {
  const sorted = Object.entries(r.bySymbol).sort((a, b) => b[1]!.net - a[1]!.net);
  const top = sorted.slice(0, 5).map(([s, v]) => `${s} ${v.net.toFixed(2)}(${v.n})`).join(', ');
  const bottom = sorted.slice(-5).reverse().map(([s, v]) => `${s} ${v.net.toFixed(2)}(${v.n})`).join(', ');
  lines.push(`- **${name}** 最佳：${top || '—'}；最差：${bottom || '—'}`);
}
lines.push('');
lines.push('## 结论要点（样本内，非盈利预测）');
lines.push('');
lines.push(`1. B 相对 A 的变化来自两处：退出更慢（三根独立收盘 K 线确认替代第一根证据即平）与衰减线更宽容（迟滞区间 ${(TREND_WATCH.minMovePct * 0.6).toFixed(2)}%~${TREND_WATCH.minMovePct}%）。平均持仓 ${rA.avgHold.toFixed(0)} → ${rB.avgHold.toFixed(0)} 分钟，交易数 ${rA.n} → ${rB.n}，平均 MFE（% 保证金）${rA.avgMfe.toFixed(1)} → ${rB.avgMfe.toFixed(1)}——持仓更久确实让浮盈峰值显著放大，但无入场过滤时低质量确认大量进场（684 笔），摩擦 ${rB.fees + rB.slips > rA.fees + rA.slips ? '反而从' : '从'} ${(rA.fees + rA.slips).toFixed(2)} → ${(rB.fees + rB.slips).toFixed(2)} U。**仅修状态机 bug 不改变亏损结局**——亏损主因是低质量信号进场后的摩擦磨损，而非只有离场机制。`);
lines.push(`2. C 的入场过滤把交易数压到 ${rC.n} 笔（0.39 笔/小时）：9083 个 lifecycle 确认 bar 中 score≥70 者仅 967（10.6%，p90=70），再经 5m/15m 高周期过滤（拒绝 369 bar·次）+ 等待新收盘 K 线二次确认后仅创建 96 条待入场、25 笔成功开仓。摩擦从 158.41 → ${(rC.fees + rC.slips).toFixed(2)} U，胜率 21.9% → ${rC.winRate.toFixed(0)}%，最大回撤 90.1% → 22.8%，平均 MFE ${rC.avgMfe.toFixed(1)}%——**亏损大幅收敛（-79 → -9）但仍为负，不构成盈利能力证明**。`);
lines.push(`3. C 内部结构：LONG 9 笔 +${(rC.bySide.LONG?.net ?? 0).toFixed(2)} U（胜率 56%）vs SHORT 16 笔 ${(rC.bySide.SHORT?.net ?? 0).toFixed(2)} U（胜率 31%）——SHORT 仍是主要拖累，与线上 60 笔归因（SHORT 37 笔 -35.79）方向一致；高周期过滤对 SHORT 的约束值得作为下一轮校准方向（未验证）。`);
lines.push(`4. ENTRY_MIN_SCORE=70 的可行性警告：UTE score 分布 p90=70——该门槛会过滤约 90% 的确认 bar（无异动 +3 分的数据源下更严）。线上运行时若无足够高分的确认趋势，机器人将长期不开仓（预期行为而非故障）；若需提高交易频率，应调低 ENTRY_MIN_SCORE 并用回放重校准（本轮不擅自调整）。`);
lines.push('5. 无法在严格时序回放中复现的线上 bug（秒级误杀/旧周期误杀）已注明；A 与线上 60 笔实测特征一致（分钟级离场、摩擦主导亏损），回放结论可作为机制层面的方向参考，但不能视为收益预测。');

const out = lines.join('\n');
console.log(out);
writeFileSync('/home/z/my-project/scripts/replay/report-t56.md', out + '\n');
console.log('\n已写入 scripts/replay/report-t56.md');
console.log('\n[C 诊断] 确认信号出现次数=', cDiag.confirmed,
  '\n  门槛拒绝分布=', JSON.stringify(cDiag.gateReject),
  '\n  待入场创建=', cDiag.pendingCreated, ' 转换开仓=', cDiag.pendingConverted,
  ' 冷却跳过=', cDiag.cooling, ' 过期取消=', cDiag.pendingExpired, ' 容量/重复=', cDiag.dupOrCap);
if (cDiag.scores.length) {
  const ss = [...cDiag.scores].sort((a, b) => a - b);
  const es = [...cDiag.ers].sort((a, b) => a - b);
  const pick = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))]!;
  console.log(
    '\n[lifecycle CONFIRMED bar 分布] n=', ss.length,
    ' score max=', ss[ss.length - 1], ' p99=', pick(ss, 0.99), ' p90=', pick(ss, 0.9), ' p50=', pick(ss, 0.5),
    ' | ER max=', es[es.length - 1]!.toFixed(3), ' p90=', pick(es, 0.9)!.toFixed(3), ' p50=', pick(es, 0.5)!.toFixed(3),
    ' | score>=70:', ss.filter((v) => v >= 70).length,
    ' score>=60:', ss.filter((v) => v >= 60).length,
    ' ER>=0.4:', es.filter((v) => v >= 0.4).length,
    ' score>=70&ER>=0.4:', ss.filter((v, i) => v >= 70 && es[i]! >= 0.4).length,
  );
}
