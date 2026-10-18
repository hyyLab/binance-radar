# -*- coding: utf-8 -*-
"""
Task 72：事件入场拒绝原因透明化（新算法「最近跳过」为空的修复）

根因：
- 旧算法（信号路径）拒绝 → auto-trader.ts:1277 `recordSkip('策略不入场：…')` → 进「最近跳过」
- 新算法（事件路径）拒绝 → auto-trader.ts:552 `continue` 完全静默 → 面板永远为空

修改 4 个文件：
1. strategy/types.ts          新增 StrategyMajorEventRejection / StrategyMajorEventEntryResult
2. strategy/major-p1-breakout.ts  10 个有信息量的拒绝分支返回带原因（预过滤分支保留 null）
3. auto-trader.ts             事件循环捕获拒绝 → recordEventSkip（60s/事件/原因 节流）
4. enhanced/engine.ts         单例 bump v21 → v22（改行为必 bump key）
"""
import io
import sys

BASE = '/home/z/my-project/src/lib/market'


def patch(path: str, replacements, filename_for_log: str):
    with io.open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    for i, (old, new, expect) in enumerate(replacements):
        count = src.count(old)
        if count != expect:
            print(f'[FAIL] {filename_for_log} R{i + 1}: expect {expect} occurrence(s), found {count}')
            print('--- anchor head ---')
            print(old[:160])
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'[OK] {filename_for_log}: {len(replacements)} replacement(s) applied')


# ============ 1) strategy/types.ts ============
TYPES = BASE + '/trend-trade/strategy/types.ts'
TYPES_EDITS = [
    # 新增拒绝类型 + 结果 union（放在 StrategyMajorEventEntryVerdict 之后）
    (
        '''/** Event entry has an event-scoped idempotency cycle and an audit snapshot. */
export interface StrategyMajorEventEntryVerdict extends StrategyEntryVerdict {
  eventCycleId: string;
  metadata: Record<string, unknown>;
}
''',
        '''/** Event entry has an event-scoped idempotency cycle and an audit snapshot. */
export interface StrategyMajorEventEntryVerdict extends StrategyEntryVerdict {
  eventCycleId: string;
  metadata: Record<string, unknown>;
}

/**
 * Task 72：事件入场拒绝结论（want=false）。事件路径的拒绝不再静默——reason 由
 * AutoPaperTrader 以「策略不入场：原因」写进「最近跳过」面板（与信号路径同语义）。
 */
export interface StrategyMajorEventRejection {
  want: false;
  side: null;
  /** 拒绝无模式标签，固定 '-' */
  modeTag: string;
  /** 中文拒绝原因（进「最近跳过」面板与审计） */
  reason: string;
}

/** 事件入场评估完整结果：通过 = 完整 verdict（带 eventCycleId/metadata）；拒绝 = 仅带原因 */
export type StrategyMajorEventEntryResult = StrategyMajorEventEntryVerdict | StrategyMajorEventRejection;
''',
        1,
    ),
    # 接口签名放宽：verdict → verdict | rejection
    (
        '  evaluateMajorEventEntry?(input: StrategyMajorEventEntryInput): StrategyMajorEventEntryVerdict | null;',
        '  evaluateMajorEventEntry?(input: StrategyMajorEventEntryInput): StrategyMajorEventEntryResult | null;',
        1,
    ),
]

# ============ 2) strategy/major-p1-breakout.ts ============
MP1 = BASE + '/trend-trade/strategy/major-p1-breakout.ts'
MP1_EDITS = [
    # import 补类型
    (
        '''import type {
  StrategyEntryVerdict,
  StrategyMajorEventEntryInput,
  StrategyMajorEventEntryVerdict,''',
        '''import type {
  StrategyEntryVerdict,
  StrategyMajorEventEntryInput,
  StrategyMajorEventEntryResult,
  StrategyMajorEventEntryVerdict,
  StrategyMajorEventRejection,''',
        1,
    ),
    # reject helper（挂在 eventCycleId 之后）
    (
        '''  private eventCycleId(event: EnhancedEventDTO): string {
    return 'MP1:' + event.id + ':' + (event.p1At ?? event.firstAt);
  }
''',
        '''  private eventCycleId(event: EnhancedEventDTO): string {
    return 'MP1:' + event.id + ':' + (event.p1At ?? event.firstAt);
  }

  /** Task 72：带原因的拒绝（reason 由 AutoPaperTrader 记进「最近跳过」，替代静默 null） */
  private reject(reason: string): StrategyMajorEventRejection {
    return { want: false, side: null, modeTag: '-', reason };
  }
''',
        1,
    ),
    # 方法签名
    (
        '  evaluateMajorEventEntry(input: StrategyMajorEventEntryInput): StrategyMajorEventEntryVerdict | null {',
        '  evaluateMajorEventEntry(input: StrategyMajorEventEntryInput): StrategyMajorEventEntryResult | null {',
        1,
    ),
    # R6：P1 新鲜窗口
    (
        '    if (currentP1 && (ageMs < 0 || (ageMs > this.params.MP1_MAX_P1_AGE_MS && !sameCycle))) return null;',
        '''    if (currentP1 && (ageMs < 0 || (ageMs > this.params.MP1_MAX_P1_AGE_MS && !sameCycle))) {
      return this.reject(ageMs < 0
        ? `P1 时间异常：年龄 ${ageMs}ms（时钟偏斜）`
        : `P1 已过期：年龄 ${ageMs}ms 超过新鲜窗口 ${this.params.MP1_MAX_P1_AGE_MS}ms`);
    }''',
        1,
    ),
    # R7：标记价 / 24h 成交额
    (
        '    if (!(ctx.mark > 0) || !Number.isFinite(quoteVolume24h) || quoteVolume24h < this.params.MP1_MIN_QV24H) return null;',
        '''    if (!(ctx.mark > 0)) return this.reject('标记价不可用（不开仓）');
    if (!Number.isFinite(quoteVolume24h) || quoteVolume24h < this.params.MP1_MIN_QV24H) {
      return this.reject(
        `24h 成交额不足：${Math.round(quoteVolume24h || 0).toLocaleString('en-US')} USDT`
        + ` < ${this.params.MP1_MIN_QV24H.toLocaleString('en-US')} USDT`,
      );
    }''',
        1,
    ),
    # R8：1m 成交额
    (
        '    if (!Number.isFinite(event.quoteVolume1m ?? 0) || (event.quoteVolume1m ?? 0) < this.params.MP1_MIN_QV1M) return null;',
        '''    if (!Number.isFinite(event.quoteVolume1m ?? 0) || (event.quoteVolume1m ?? 0) < this.params.MP1_MIN_QV1M) {
      return this.reject(
        `1m 成交额不足：${Math.round(event.quoteVolume1m ?? 0).toLocaleString('en-US')} USDT`
        + ` < ${this.params.MP1_MIN_QV1M.toLocaleString('en-US')} USDT`,
      );
    }''',
        1,
    ),
    # R9：已有持仓
    (
        '    if (ctx.openSymbols.has(event.symbol)) return null;',
        "    if (ctx.openSymbols.has(event.symbol)) return this.reject('该币种已有 OPEN 持仓');",
        1,
    ),
    # R10：轮次上限
    (
        '    if (round > this.params.MP1_MAX_ROUNDS_PER_EVENT) return null;',
        '''    if (round > this.params.MP1_MAX_ROUNDS_PER_EVENT) {
      return this.reject(`本事件轮次已达上限 ${this.params.MP1_MAX_ROUNDS_PER_EVENT}（round=${round}）`);
    }''',
        1,
    ),
    # R11：假突破反手前提
    (
        '      if (!(baseline != null && baseline > 0 && previousTradeStopped)) return null;',
        '''      if (!(baseline != null && baseline > 0 && previousTradeStopped)) {
        return this.reject('假突破反手未就绪：需有效基准线且上一轮以止损离场');
      }''',
        1,
    ),
    # R12：假突破回收/反手同向
    (
        '      if (!returnedInside || state.lastEntrySide === side) return null;',
        '''      if (!returnedInside) return this.reject('假突破未回收：价格未回到突破基准内侧');
      if (state.lastEntrySide === side) return this.reject('假突破反手方向与上一轮相同');''',
        1,
    ),
    # R13：倾向冲突
    (
        '''        if ((event.dir === 'UP' && event.direction.tendency === 'SHORT') ||
            (event.dir === 'DOWN' && event.direction.tendency === 'LONG')) return null;''',
        '''        if ((event.dir === 'UP' && event.direction.tendency === 'SHORT') ||
            (event.dir === 'DOWN' && event.direction.tendency === 'LONG')) {
          return this.reject(`突破方向与事件短期倾向冲突（dir=${event.dir}，tendency=${event.direction.tendency}）`);
        }''',
        1,
    ),
    # R14：再入场间隔
    (
        '      if (state.lastExitAt == null || ctx.now - state.lastExitAt < this.params.MP1_REENTRY_MIN_GAP_MS) return null;',
        '''      if (state.lastExitAt == null) return this.reject('同事件再入场缺少上次离场时刻');
      if (ctx.now - state.lastExitAt < this.params.MP1_REENTRY_MIN_GAP_MS) {
        return this.reject(
          `再入场间隔不足：距上次离场 ${ctx.now - state.lastExitAt}ms < ${this.params.MP1_REENTRY_MIN_GAP_MS}ms`,
        );
      }''',
        1,
    ),
    # R15：再入场证据
    (
        '''        if (state.lastEntrySide !== side || !(state.lastExitPrice != null && state.lastExitPrice > 0)) return null;
        if (signedPriceMovePct(side, state.lastExitPrice, ctx.mark) < this.params.MP1_REENTRY_MOVE_PCT) return null;''',
        '''        if (state.lastEntrySide !== side || !(state.lastExitPrice != null && state.lastExitPrice > 0)) {
          return this.reject('再入场未就绪：需与上一轮同向且上一轮有有效离场价');
        }
        if (signedPriceMovePct(side, state.lastExitPrice, ctx.mark) < this.params.MP1_REENTRY_MOVE_PCT) {
          return this.reject(
            `再入场证据不足：自上次离场价顺向再走 ${this.params.MP1_REENTRY_MOVE_PCT}% 才追入`
            + `（当前 ${signedPriceMovePct(side, state.lastExitPrice, ctx.mark).toFixed(2)}%）`,
          );
        }''',
        1,
    ),
]

# ============ 3) auto-trader.ts ============
AT = BASE + '/trend-trade/auto-trader.ts'
AT_EDITS = [
    # 字段：事件拒绝去重 memo
    (
        '  private skips: SkipRecord[] = [];',
        '''  private skips: SkipRecord[] = [];
  /** Task 72：事件路径拒绝去重（eventId → 最近原因/时刻）；同因 60s 一条，原因变化立即记 */
  private eventSkips = new Map<string, { reason: string; at: number }>();''',
        1,
    ),
    # 事件循环：拒绝不再静默
    (
        '''        const eventVerdict = evaluateMajorEventEntry({ event, candles, quoteVolume24h, ctx });
        if (!eventVerdict || !eventVerdict.want || !eventVerdict.side) continue;''',
        '''        const eventVerdict = evaluateMajorEventEntry({ event, candles, quoteVolume24h, ctx });
        if (!eventVerdict || !eventVerdict.want || !eventVerdict.side) {
          // Task 72：事件路径拒绝不再静默——原因进「最近跳过」（与信号路径「策略不入场」同语义；
          // 事件循环 1s 一跑，同一事件同一原因会反复评估，60s 节流防刷屏）
          this.recordEventSkip(event, `策略不入场：${eventVerdict?.reason ?? '事件未通过策略门槛'}`);
          continue;
        }''',
        1,
    ),
    # recordEventSkip 方法（pushSkip 之后）
    (
        '''  private pushSkip(symbol: string, reason: string, cycleId?: string): void {
    this.skips.unshift({ t: Date.now(), symbol, reason, cycleId });
    if (this.skips.length > 200) this.skips.length = 200;
  }
''',
        '''  private pushSkip(symbol: string, reason: string, cycleId?: string): void {
    this.skips.unshift({ t: Date.now(), symbol, reason, cycleId });
    if (this.skips.length > 200) this.skips.length = 200;
  }

  /**
   * Task 72：事件路径拒绝记录（带节流去重）。事件循环每 1s 对每个活跃 MAJOR P1 事件重复
   * 评估：同一事件同一原因 60s 只记一条、原因变化立即记录；memo 超 64 条时清理 10 分钟前
   * 的旧键防泄漏。cycleId 留空（事件周期键在策略内部，面板展示以原因为主）。
   */
  private recordEventSkip(event: { id: string; symbol: string }, reason: string): void {
    const now = Date.now();
    if (this.eventSkips.size > 64) {
      for (const [key, memo] of this.eventSkips) {
        if (now - memo.at > 600_000) this.eventSkips.delete(key);
      }
    }
    const prev = this.eventSkips.get(event.id);
    if (prev && prev.reason === reason && now - prev.at < 60_000) return;
    this.eventSkips.set(event.id, { reason, at: now });
    this.pushSkip(event.symbol, reason);
  }
''',
        1,
    ),
]

# ============ 4) enhanced/engine.ts（单例 bump v21 → v22） ============
EN = BASE + '/enhanced/engine.ts'
EN_EDITS = [
    # 版本变更注释（v22 插在单例头之后、v21 之前）
    (
        '''// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v21（Task 69）：重大异动突破 v1''',
        '''// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v22（Task 72）：事件入场拒绝透明化——major-p1 事件路径每个有信息量的拒绝分支返回带原因的
//   StrategyMajorEventRejection（P1 过期/流动性不足/轮次上限/假突破未回收/再入场条件不满足等），
//   autoTrader 事件循环捕获后以「策略不入场：原因」写进「最近跳过」（60s/事件/原因 节流，
//   防止 1s 事件循环刷屏）。与信号路径 recordSkip 语义对齐。改行为必 bump key。
// v21（Task 69）：重大异动突破 v1''',
        1,
    ),
    # globalThis 类型：追加 v22 键
    (
        '  __binanceRadarEnhanced_v21?: EnhancedEngine; // v21（Task 69）：MAJOR P1 event-driven breakout\n};',
        '''  __binanceRadarEnhanced_v21?: EnhancedEngine; // v21（Task 69）：MAJOR P1 event-driven breakout
  __binanceRadarEnhanced_v22?: EnhancedEngine; // v22（Task 72）：事件拒绝原因进「最近跳过」
};''',
        1,
    ),
    # pickLegacyEngine 参数类型：追加 v22 键
    (
        '''    __binanceRadarEnhanced_v21?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
        '''    __binanceRadarEnhanced_v21?: EnhancedEngine;
    __binanceRadarEnhanced_v22?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
        1,
    ),
    # pickLegacyEngine 返回链：v22 优先
    (
        '''  return (
    g.__binanceRadarEnhanced_v21 ??''',
        '''  return (
    g.__binanceRadarEnhanced_v22 ??
    g.__binanceRadarEnhanced_v21 ??''',
        1,
    ),
    # getEnhancedEngine：v21 → v22
    (
        '''export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v21;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v21 = fresh;
  return fresh;
}''',
        '''export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v22;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v22 = fresh;
  return fresh;
}''',
        1,
    ),
    # resetEnhancedEngine：v21 → v22
    (
        '''export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v21 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v21 = fresh;
  return fresh;
}''',
        '''export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v22 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v22 = fresh;
  return fresh;
}''',
        1,
    ),
]

if __name__ == '__main__':
    patch(TYPES, TYPES_EDITS, 'strategy/types.ts')
    patch(MP1, MP1_EDITS, 'strategy/major-p1-breakout.ts')
    patch(AT, AT_EDITS, 'auto-trader.ts')
    patch(EN, EN_EDITS, 'engine.ts')
    print('[DONE] Task 72 patch applied to 4 files')
