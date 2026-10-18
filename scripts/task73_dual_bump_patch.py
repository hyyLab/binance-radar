# -*- coding: utf-8 -*-
"""
Task 73 续（修订）：SOURCE_LABEL 文案生效需双单例同步 bump
- futures-collector.ts v5 → v6：label 来自采集器 DTO（collector.ts:617），旧实例绑定旧模块
- engine.ts v23 → v24：同一保存内 bump，新引擎 boot() 经 activeFuturesCollector() 动态
  拿到 v6 并 ensureStarted()（若只换采集器，v6 无人启动会冻结行情定时器）
"""
import io
import sys

FC = '/home/z/my-project/src/lib/market/futures-collector.ts'
EN = '/home/z/my-project/src/lib/market/enhanced/engine.ts'

FC_EDITS = [
    (
        '''// v5（Task 70）：币安封禁期白名单降级——Bybit∩Gate 交集代管品种池（白名单空则
// 分片/聚合全停、全站无数据），解封后真 exchangeInfo 到货自动覆盖回真白名单。''',
        '''// v5（Task 70）：币安封禁期白名单降级——Bybit∩Gate 交集代管品种池（白名单空则
// 分片/聚合全停、全站无数据），解封后真 exchangeInfo 到货自动覆盖回真白名单。
// v6（Task 73）：SOURCE_LABEL['binance'] 文案 '币安U本位'→'binanceU本位'（页面展示），
// 状态交接重建（清单/价格史/统计/分片/封禁状态全继承）。''',
        1,
    ),
    (
        '''  __binanceRadarFutures_v5?: FuturesCollector;
  __binanceRadarFuturesActive?: FuturesCollector;''',
        '''  __binanceRadarFutures_v5?: FuturesCollector;
  __binanceRadarFutures_v6?: FuturesCollector; // v6（Task 73）：label 文案 binance 化
  __binanceRadarFuturesActive?: FuturesCollector;''',
        1,
    ),
    (
        '''export const futuresCollector: FuturesCollector = (() => {
  const existing = g.__binanceRadarFutures_v5;
  if (existing) {
    g.__binanceRadarFuturesActive = existing; // 每次图评估都刷新稳定别名
    return existing;
  }
  const legacy =
    g.__binanceRadarFutures_v4 ?? g.__binanceRadarFutures_v3 ?? g.__binanceRadarFutures_v2 ?? g.__binanceRadarFutures_v1;
  if (legacy) clearFuturesTimers(legacy); // 遗留实例停表
  const fresh = new FuturesCollector(legacy); // 状态交接（清单/价格史/统计/分片/封禁状态）
  g.__binanceRadarFutures_v5 = fresh;
  g.__binanceRadarFuturesActive = fresh;
  return fresh;''',
        '''export const futuresCollector: FuturesCollector = (() => {
  const existing = g.__binanceRadarFutures_v6;
  if (existing) {
    g.__binanceRadarFuturesActive = existing; // 每次图评估都刷新稳定别名
    return existing;
  }
  const legacy =
    g.__binanceRadarFutures_v5 ?? g.__binanceRadarFutures_v4 ?? g.__binanceRadarFutures_v3
      ?? g.__binanceRadarFutures_v2 ?? g.__binanceRadarFutures_v1;
  if (legacy) clearFuturesTimers(legacy); // 遗留实例停表
  const fresh = new FuturesCollector(legacy); // 状态交接（清单/价格史/统计/分片/封禁状态）
  g.__binanceRadarFutures_v6 = fresh;
  g.__binanceRadarFuturesActive = fresh;
  return fresh;''',
        1,
    ),
]

EN_EDITS = [
    (
        '''// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v23（Task 73）：页面文案「币安」→「binance」''',
        '''// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v24（Task 73 续）：与采集器 v6 同步 bump——boot() 经 activeFuturesCollector() 动态解析
//   新采集器并 ensureStarted()，保证 SOURCE_LABEL 文案生效的同时行情定时器不断供。
//   改行为必 bump key。
// v23（Task 73）：页面文案「币安」→「binance」''',
        1,
    ),
    (
        '''  __binanceRadarEnhanced_v23?: EnhancedEngine; // v23（Task 73）：SOURCE_LABEL 文案 binance 化
};''',
        '''  __binanceRadarEnhanced_v23?: EnhancedEngine; // v23（Task 73）：SOURCE_LABEL 文案 binance 化
  __binanceRadarEnhanced_v24?: EnhancedEngine; // v24（Task 73 续）：同步采集器 v6 重建
};''',
        1,
    ),
    (
        '''    __binanceRadarEnhanced_v23?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
        '''    __binanceRadarEnhanced_v23?: EnhancedEngine;
    __binanceRadarEnhanced_v24?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
        1,
    ),
    (
        '''  return (
    g.__binanceRadarEnhanced_v23 ??''',
        '''  return (
    g.__binanceRadarEnhanced_v24 ??
    g.__binanceRadarEnhanced_v23 ??''',
        1,
    ),
    (
        '''export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v23;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v23 = fresh;
  return fresh;
}''',
        '''export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v24;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v24 = fresh;
  return fresh;
}''',
        1,
    ),
    (
        '''export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v23 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v23 = fresh;
  return fresh;
}''',
        '''export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v24 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v24 = fresh;
  return fresh;
}''',
        1,
    ),
]


def patch(path: str, edits, name: str) -> None:
    with io.open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    for i, (old, new, expect) in enumerate(edits):
        count = src.count(old)
        if count != expect:
            print(f'[FAIL] {name} R{i + 1}: expect {expect}, found {count}')
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'[OK] {name}: {len(edits)} edit(s)')


if __name__ == '__main__':
    patch(FC, FC_EDITS, 'futures-collector.ts v5->v6')
    patch(EN, EN_EDITS, 'engine.ts v23->v24')
    print('[DONE] dual singleton bump applied')
