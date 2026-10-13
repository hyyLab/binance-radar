// ---------- 升级版异动交易 · 三检测器（独立运行，互不依赖） ----------
// SPIKE：固定阈值 + 自适应阈值（近 6h/12h 中位数×倍数）+ 极端幅度快速通道（§三）
// BREAKOUT：24h 滚动前高/前低状态机 PENDING→CONFIRMED，假突破标记 + 异常复核（§四）
// VOLUME：过去 20 根完整 1m K 线成交额中位数 6x/12x（§五）
// 三者只读 KlineStore 与 TickSnap，产出 Detection 交给聚合器。

import { BREAKOUT, SPIKE, VOLUME } from './config';
import type { KlineStore } from './klines';
import type { Detection, SymStats } from './types';

export interface TickSnap {
  symbol: string;
  base: string;
  price: number;
  chg1m: number | null;
  chg5m: number | null;
  vol1m: number;
  quoteVolume24h: number;
  change24h: number;
  updatedAt: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

// ============ SPIKE（§三） ============

export function detectSpike(snap: TickSnap, stats: SymStats | undefined): Detection | null {
  if (!stats || !stats.tradingOk) return null;
  if (snap.quoteVolume24h < SPIKE.minQv24h) return null;
  const qv1m = snap.vol1m ?? 0;
  if (qv1m < SPIKE.minQv1m) return null;

  const c1 = snap.chg1m;
  const c5 = snap.chg5m;

  // 极端绝对幅度快速通道（§三：不必等相对波动条件，仍要求成交额支持——上面已过门槛）
  if (c1 != null && Math.abs(c1) >= SPIKE.extremeM1) {
    return {
      detector: 'SPIKE',
      dir: c1 >= 0 ? 'UP' : 'DOWN',
      level: 'MAJOR',
      magnitude: Math.abs(c1),
      price: snap.price,
      detail: `1m ${c1 > 0 ? '+' : ''}${c1.toFixed(2)}%（极端幅度快速通道 ≥${SPIKE.extremeM1}%）`,
      windows: ['1m'],
      adaptiveUsed: false,
      quoteVolume1m: qv1m,
    };
  }
  if (c5 != null && Math.abs(c5) >= SPIKE.extremeM5) {
    return {
      detector: 'SPIKE',
      dir: c5 >= 0 ? 'UP' : 'DOWN',
      level: 'MAJOR',
      magnitude: Math.abs(c5),
      price: snap.price,
      detail: `5m ${c5 > 0 ? '+' : ''}${c5.toFixed(2)}%（极端幅度快速通道 ≥${SPIKE.extremeM5}%）`,
      windows: ['5m'],
      adaptiveUsed: false,
      quoteVolume1m: qv1m,
    };
  }

  // 1m / 5m 双窗口评估（自适应阈值 = max(固定, 中位数×倍数)），两窗同时命中则合并标注
  const hits: {
    win: '1m' | '5m';
    chg: number;
    level: 'MINOR' | 'MAJOR';
    th: number;
    adaptive: boolean;
  }[] = [];
  if (c1 != null) {
    const med = stats.medAbs1m;
    const thMinor = med != null ? Math.max(SPIKE.fixed.m1Minor, med * SPIKE.adaptiveMultMinor) : SPIKE.fixed.m1Minor;
    const thMajor = med != null ? Math.max(SPIKE.fixed.m1Major, med * SPIKE.adaptiveMultMajor) : SPIKE.fixed.m1Major;
    const a = Math.abs(c1);
    if (a >= thMajor) hits.push({ win: '1m', chg: c1, level: 'MAJOR', th: thMajor, adaptive: med != null });
    else if (a >= thMinor) hits.push({ win: '1m', chg: c1, level: 'MINOR', th: thMinor, adaptive: med != null });
  }
  if (c5 != null) {
    const med = stats.medAbs5m;
    const thMinor = med != null ? Math.max(SPIKE.fixed.m5Minor, med * SPIKE.adaptiveMultMinor) : SPIKE.fixed.m5Minor;
    const thMajor = med != null ? Math.max(SPIKE.fixed.m5Major, med * SPIKE.adaptiveMultMajor) : SPIKE.fixed.m5Major;
    const a = Math.abs(c5);
    if (a >= thMajor) hits.push({ win: '5m', chg: c5, level: 'MAJOR', th: thMajor, adaptive: med != null });
    else if (a >= thMinor) hits.push({ win: '5m', chg: c5, level: 'MINOR', th: thMinor, adaptive: med != null });
  }
  if (hits.length === 0) return null;

  const best = hits.find((h) => h.level === 'MAJOR') ?? hits[0];
  const label = hits.map((h) => h.win).join('+');
  return {
    detector: 'SPIKE',
    dir: best.chg >= 0 ? 'UP' : 'DOWN',
    level: best.level,
    magnitude: Math.abs(best.chg),
    price: snap.price,
    detail: `${best.win} ${best.chg > 0 ? '+' : ''}${best.chg.toFixed(2)}%（${best.level} 阈值 ${best.th.toFixed(2)}%${best.adaptive ? '，自适应生效' : ''}）${hits.length > 1 ? ` · ${label} 同时命中` : ''}`,
    windows: hits.map((h) => h.win),
    adaptiveUsed: best.adaptive,
    quoteVolume1m: qv1m,
  };
}

// ============ VOLUME_SURGE（§五） ============

export function detectVolume(
  snap: TickSnap,
  store: KlineStore,
  now: number,
): { detection: Detection | null } {
  void now;
  if (snap.quoteVolume24h < VOLUME.minQv24h) return { detection: null };
  const qv1m = snap.vol1m ?? 0;
  if (qv1m < VOLUME.minQv1m) return { detection: null };
  if (!store.has(snap.symbol)) return { detection: null };

  const qvs = store.recentClosedQv(snap.symbol, VOLUME.baselineCandles);
  if (qvs.length < VOLUME.baselineCandles) return { detection: null }; // 基线未就绪
  const med = median(qvs);
  if (med == null || med < VOLUME.minBaselineQv) return { detection: null }; // BASELINE_INSUFFICIENT

  const mult = qv1m / med;
  if (mult < VOLUME.minorMult) return { detection: null };

  const level = mult >= VOLUME.majorMult || qv1m >= VOLUME.majorAbsQv1m ? 'MAJOR' : 'MINOR';
  const c5 = snap.chg5m ?? 0;
  const dir = c5 >= VOLUME.dirMinChg5m ? 'UP' : c5 <= -VOLUME.dirMinChg5m ? 'DOWN' : 'NEUTRAL';

  return {
    detection: {
      detector: 'VOLUME',
      dir,
      level,
      magnitude: mult,
      price: snap.price,
      detail: `1m 成交额 ${fmtUsd(qv1m)} = 20 根 1m 中位数的 ${mult.toFixed(1)} 倍（中位数 ${fmtUsd(med)}）`,
      quoteVolume1m: qv1m,
    },
  };
}

// ============ BREAKOUT（§四）：24h 滚动高低点状态机 ============

interface BreakoutState {
  dir: 'UP' | 'DOWN';
  phase: 'PENDING' | 'CONFIRMED' | 'REVIEW';
  ticks: number; // PENDING 确认计数 / REVIEW 复核计数
  baseline: number; // 进入 PENDING 时冻结的 24h 前高/前低（防基线随突破上移漂移）
  confirmedAt: number;
}

export class BreakoutTracker {
  private states = new Map<string, BreakoutState>();

  /** 每 2s tick：进入/推进/假突破判定；PENDING 仅首次进入产出候选（防证据灌水） */
  onTick(snap: TickSnap, stats: SymStats | undefined, store: KlineStore, now: number): Detection | null {
    if (!stats || !stats.tradingOk) return null;
    if (snap.quoteVolume24h < BREAKOUT.minQv24h) {
      this.states.delete(snap.symbol);
      return null;
    }
    const range = store.range24h(snap.symbol, now);
    if (!range) return null; // 基线未就绪（24h 样本不足）

    const buffer = Math.max(stats.tickSize * BREAKOUT.tickMult, snap.price * BREAKOUT.pctBuffer);
    const beyondUp = snap.price > range.high + buffer;
    const beyondDown = snap.price < range.low - buffer;
    const st = this.states.get(snap.symbol);

    // —— 无进行中状态 ——
    if (!st) {
      if (!beyondUp && !beyondDown) return null;
      const dir: 'UP' | 'DOWN' = beyondUp ? 'UP' : 'DOWN';
      const base = beyondUp ? range.high : range.low;
      const beyondPct = beyondPctOf(snap.price, base, dir);
      if (Math.abs(beyondPct) > BREAKOUT.anomalyPct) {
        // 异常偏离保护 → 复核（不推送不丢弃）
        this.states.set(snap.symbol, { dir, phase: 'REVIEW', ticks: 1, baseline: base, confirmedAt: 0 });
        return null;
      }
      this.states.set(snap.symbol, { dir, phase: 'PENDING', ticks: 1, baseline: base, confirmedAt: 0 });
      return {
        detector: 'BREAKOUT',
        dir,
        level: 'PENDING',
        magnitude: beyondPct,
        price: snap.price,
        baseline: base,
        detail: `价格${dir === 'UP' ? '突破 24h 滚动前高' : '跌破 24h 滚动前低'}（${beyondPct > 0 ? '+' : ''}${beyondPct.toFixed(2)}%，待确认）`,
      };
    }

    // —— REVIEW 复核中 ——
    if (st.phase === 'REVIEW') {
      const stillBeyond = st.dir === 'UP' ? beyondUp : beyondDown;
      const volOk = (snap.vol1m ?? 0) >= BREAKOUT.reviewMinQv1m;
      if (stillBeyond && volOk) {
        st.ticks++;
        if (st.ticks >= BREAKOUT.reviewTicks) {
          st.phase = 'CONFIRMED';
          st.confirmedAt = now;
          const beyondPct = beyondPctOf(snap.price, st.baseline, st.dir);
          return {
            detector: 'BREAKOUT',
            dir: st.dir,
            level: 'MAJOR',
            magnitude: beyondPct,
            price: snap.price,
            baseline: st.baseline,
            confirmVia: 'TICKS',
            detail: `异常偏离复核通过（连续 ${BREAKOUT.reviewTicks} tick + 成交额支持），有效${st.dir === 'UP' ? '突破' : '跌破'}（超越 ${beyondPct.toFixed(2)}%）`,
          };
        }
      } else {
        this.states.delete(snap.symbol); // 复核失败，回到无状态
      }
      return null;
    }

    const stillBeyond = st.dir === 'UP' ? snap.price > st.baseline + buffer : snap.price < st.baseline - buffer;
    const beyondPct = beyondPctOf(snap.price, st.baseline, st.dir);

    // —— PENDING：连续界外确认 ——
    if (st.phase === 'PENDING') {
      if (!stillBeyond) {
        this.states.delete(snap.symbol); // 回到区间，撤销候选（不打假突破标记）
        return null;
      }
      st.ticks++;
      if (st.ticks >= BREAKOUT.confirmTicks) {
        st.phase = 'CONFIRMED';
        st.confirmedAt = now;
        return {
          detector: 'BREAKOUT',
          dir: st.dir,
          level: 'MAJOR',
          magnitude: beyondPct,
          price: snap.price,
          baseline: st.baseline,
          confirmVia: 'TICKS',
          detail: `有效${st.dir === 'UP' ? '突破 24h 滚动前高' : '跌破 24h 滚动前低'}（超越 ${beyondPct.toFixed(2)}%，连续报价确认）`,
        };
      }
      return null;
    }

    // —— CONFIRMED：假突破观察期 ——
    if (!stillBeyond) {
      this.states.delete(snap.symbol);
      if (now - st.confirmedAt <= BREAKOUT.falseObservationMs) {
        return {
          detector: 'BREAKOUT',
          dir: st.dir,
          level: 'PENDING',
          magnitude: beyondPct,
          price: snap.price,
          baseline: st.baseline,
          detail: `假突破：价格已回到 24h 区间内（基准 ${st.baseline}），突破有效性丧失`,
        };
      }
      return null; // 观察期外自然回落：不标记，事件靠静默判定结束
    }
    return null; // 持续界外：确认后不重复产出
  }

  /** 确认 B：最后一根已收盘 1m K 线收盘价仍在界外 → 立即确认（1m 收盘确认） */
  onCloseCheck(symbol: string, now: number, store: KlineStore): Detection | null {
    const st = this.states.get(symbol);
    if (!st || st.phase !== 'PENDING') return null;
    const closed = store.closedCandles(symbol, 10 * 60_000, now);
    if (closed.length === 0) return null;
    const last = closed[closed.length - 1];
    if (last.t + 60_000 < now - 60_000) return null; // 收盘数据滞后，不判
    const buffer = last.c * BREAKOUT.pctBuffer;
    const stillBeyond = st.dir === 'UP' ? last.c > st.baseline + buffer : last.c < st.baseline - buffer;
    if (!stillBeyond) return null;
    st.phase = 'CONFIRMED';
    st.confirmedAt = now;
    const beyondPct = beyondPctOf(last.c, st.baseline, st.dir);
    return {
      detector: 'BREAKOUT',
      dir: st.dir,
      level: 'MAJOR',
      magnitude: beyondPct,
      price: last.c,
      baseline: st.baseline,
      confirmVia: 'CLOSE',
      detail: `有效${st.dir === 'UP' ? '突破 24h 滚动前高' : '跌破 24h 滚动前低'}（超越 ${beyondPct.toFixed(2)}%，1m 收盘确认）`,
    };
  }
}

function beyondPctOf(price: number, base: number, dir: 'UP' | 'DOWN'): number {
  return dir === 'UP' ? ((price - base) / base) * 100 : ((base - price) / base) * 100;
}
