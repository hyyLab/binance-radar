// ---------- 策略注册表（Task 57：算法可插拔的唯一入口） ----------
// 新增算法三步：实现 TrendStrategy 接口 → 在 STRATEGY_FACTORIES 注册 → UI 自动出现。
// AutoPaperTrader 只依赖 registry（createStrategy/listStrategies），不依赖具体策略类。
// Task 57-c：工厂支持参数覆盖（控制台调参 → createStrategy(id, params) 热装配）。

import { ShortSwingStrategy, type ShortSwingParams } from './short-swing';
import type { StrategyDescriptor, TrendStrategy } from './types';

/** 策略工厂表（id → 实例构造；params 为已校验的覆盖项，键随策略自解释） */
const STRATEGY_FACTORIES: Record<string, (params?: Record<string, unknown>) => TrendStrategy> = {
  'short-swing-v1': (p) => new ShortSwingStrategy(p as ShortSwingParams | undefined),
};

/** 默认策略（TrendAutoConfig.strategyId 播种值；不存在/未知 id 时兜底） */
export const DEFAULT_STRATEGY_ID = 'short-swing-v1';

/** 创建策略实例（未知 id 兜底默认策略，绝不抛错阻断交易循环） */
export function createStrategy(id: string | null | undefined, params?: Record<string, unknown>): TrendStrategy {
  const factory = (id && STRATEGY_FACTORIES[id]) || STRATEGY_FACTORIES[DEFAULT_STRATEGY_ID];
  return factory(params);
}

/** 可选策略列表（UI 下拉/说明用） */
export function listStrategies(): StrategyDescriptor[] {
  return Object.entries(STRATEGY_FACTORIES).map(([, f]) => {
    const s = f();
    return { id: s.id, name: s.name, description: s.description };
  });
}

/** id 是否已注册 */
export function isKnownStrategy(id: string): boolean {
  return id in STRATEGY_FACTORIES;
}
