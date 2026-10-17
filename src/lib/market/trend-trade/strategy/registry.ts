// ---------- 策略注册表（Task 57：算法可插拔的唯一入口） ----------
// 新增算法三步：实现 TrendStrategy 接口 → 在 STRATEGY_FACTORIES 注册 → UI 自动出现
// （完整指引见 docs/strategy-interface.md §6 与 strategy/README.md）。
// AutoPaperTrader 只依赖 registry（createStrategy/listStrategies），不依赖具体策略类。
// Task 57-c：工厂支持参数覆盖（控制台调参 → createStrategy(id, params) 热装配）。
//
// ── 已注册算法清单 ──────────────────────────────────────────────
// │ id                  │ 名称       │ 一句话定位
// │ short-swing-v1      │ 短周期套利  │ 默认算法：确认+评分/ER 门槛+5m 背景分级+冲高落袋
// │ universal-trend-v1  │ 通用趋势引擎│ 最开始的 UTE 直通车：确认即顺势、确认在就拿满、无冲高落袋
// ────────────────────────────────────────────────────────────────
// 默认算法保持 short-swing-v1（Task 62 用户定版：UTE 先上架可选，控制台暂用
// 其代码默认参数；切换在 UI 算法下拉进行，切换前自动平仓清场由 control API 负责）。

import { ShortSwingStrategy, type ShortSwingParams } from './short-swing';
import { UniversalTrendStrategy, type UniversalTrendParams } from './universal-trend';
import type { StrategyDescriptor, TrendStrategy } from './types';

/** 策略工厂表（id → 实例构造；params 为已校验的覆盖项，键随策略自解释） */
const STRATEGY_FACTORIES: Record<string, (params?: Record<string, unknown>) => TrendStrategy> = {
  'short-swing-v1': (p) => new ShortSwingStrategy(p as ShortSwingParams | undefined),
  'universal-trend-v1': (p) => new UniversalTrendStrategy(p as UniversalTrendParams | undefined),
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
