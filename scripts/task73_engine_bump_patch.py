# -*- coding: utf-8 -*-
"""
Task 73 续：engine.ts 单例 bump v22 → v23
原因：futures-feeds.ts 的 SOURCE_LABEL['binance']（'币安U本位'→'binanceU本位'）被常驻
采集器单例引用，HMR 不重建 globalThis 实例——按「改行为必 bump key」惯例换血，
让源健康面板的 label 立即用新文案。
"""
import io
import sys

PATH = '/home/z/my-project/src/lib/market/enhanced/engine.ts'

EDITS = [
    # 版本注释
    (
        '''// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v22（Task 72）：事件入场拒绝透明化''',
        '''// ============ 单例（globalThis 驻留，HMR 不重复启动） ==========
// v23（Task 73）：页面文案「币安」→「binance」——SOURCE_LABEL['binance'] 值改为
//   'binanceU本位'（源健康面板/交易弹窗展示），采集器 DTO label 随单例重建生效。
//   改行为必 bump key。
// v22（Task 72）：事件入场拒绝透明化''',
        1,
    ),
    # globalThis 类型
    (
        '  __binanceRadarEnhanced_v22?: EnhancedEngine; // v22（Task 72）：事件拒绝原因进「最近跳过」\n};',
        '''  __binanceRadarEnhanced_v22?: EnhancedEngine; // v22（Task 72）：事件拒绝原因进「最近跳过」
  __binanceRadarEnhanced_v23?: EnhancedEngine; // v23（Task 73）：SOURCE_LABEL 文案 binance 化
};''',
        1,
    ),
    # pickLegacyEngine 参数类型
    (
        '''    __binanceRadarEnhanced_v22?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
        '''    __binanceRadarEnhanced_v22?: EnhancedEngine;
    __binanceRadarEnhanced_v23?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
        1,
    ),
    # 返回链
    (
        '''  return (
    g.__binanceRadarEnhanced_v22 ??''',
        '''  return (
    g.__binanceRadarEnhanced_v23 ??
    g.__binanceRadarEnhanced_v22 ??''',
        1,
    ),
    # getEnhancedEngine
    (
        '''export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v22;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v22 = fresh;
  return fresh;
}''',
        '''export function getEnhancedEngine(): EnhancedEngine {
  const existing = g.__binanceRadarEnhanced_v23;
  if (existing) return existing;
  const legacy = pickLegacyEngine(g);
  if (legacy) stopLegacyEngine(legacy);
  const fresh = new EnhancedEngine(carryStoreOf(legacy));
  g.__binanceRadarEnhanced_v23 = fresh;
  return fresh;
}''',
        1,
    ),
    # resetEnhancedEngine
    (
        '''export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v22 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v22 = fresh;
  return fresh;
}''',
        '''export function resetEnhancedEngine(): EnhancedEngine {
  const old = g.__binanceRadarEnhanced_v23 ?? pickLegacyEngine(g);
  stopLegacyEngine(old);
  const fresh = new EnhancedEngine(carryStoreOf(old));
  g.__binanceRadarEnhanced_v23 = fresh;
  return fresh;
}''',
        1,
    ),
]


def main() -> None:
    with io.open(PATH, 'r', encoding='utf-8') as f:
        src = f.read()
    for i, (old, new, expect) in enumerate(EDITS):
        count = src.count(old)
        if count != expect:
            print(f'[FAIL] R{i + 1}: expect {expect}, found {count}')
            print(old[:120])
            sys.exit(1)
        src = src.replace(old, new)
    with io.open(PATH, 'w', encoding='utf-8') as f:
        f.write(src)
    print('[DONE] engine.ts bumped v22 -> v23 (6 edits)')


if __name__ == '__main__':
    main()
