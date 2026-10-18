// ---------- 策略注册表（Task 57：算法可插拔的唯一入口） ----------
// 新增算法三步：实现 TrendStrategy 接口 → 在 STRATEGY_FACTORIES 注册 → UI 自动出现
// （完整指引见 docs/strategy-interface.md §6 与 strategy/README.md）。
// AutoPaperTrader 只依赖 registry（createStrategy/listStrategies），不依赖具体策略类。
// Task 57-c：工厂支持参数覆盖（控制台调参 → createStrategy(id, params) 热装配）。
//
// ── 已注册算法清单 ──────────────────────────────────────────────
// │ id                  │ 名称       │ 一句话定位
// │ short-swing-v1      │ 短周期套利  │ 默认算法：确认+评分/ER 门槛+5m 背景分级+冲高落袋
// │ universal-trend-v1  │ 通用趋势引擎│ 最开始的 UTE 长周期跟随：确认+方向选择证据才入场、确认在就拿满周期、走弱不离场
// │ major-p1-breakout-v1│ 重大异动突破│ MAJOR P1 事件驱动；平台突破优先，加速型缩小风险预算
// │ strong-trend-v1     │ 强趋势顺随  │ 历史评分阈值对照组；后续时段显示明显 regime 敏感性
// │ adaptive-ute-v2     │ 自适应 UTE │ 原始五因子 + 波动结构 + 高周期，按证据分流顺势/反转
// ────────────────────────────────────────────────────────────────
// 默认算法保持 short-swing-v1（Task 62 用户定版：UTE 先上架可选，控制台暂用
// 其代码默认参数；切换在 UI 算法下拉进行，切换前自动平仓清场由 control API 负责）。

import { ShortSwingStrategy, type ShortSwingParams } from './short-swing';
import { UniversalTrendStrategy, type UniversalTrendParams } from './universal-trend';
import { AdaptiveUteV2Strategy, type AdaptiveUteV2Params } from './adaptive-ute-v2';
import { MajorP1BreakoutStrategy, type MajorP1BreakoutParams } from './major-p1-breakout';
import type { StrategyDescriptor, TrendStrategy } from './types';

/** 策略工厂表（id → 实例构造；params 为已校验的覆盖项，键随策略自解释） */
const STRATEGY_FACTORIES: Record<string, (params?: Record<string, unknown>) => TrendStrategy> = {
  'short-swing-v1': (p) => new ShortSwingStrategy(p as ShortSwingParams | undefined),
  'universal-trend-v1': (p) => new UniversalTrendStrategy(p as UniversalTrendParams | undefined),
  // Task 82：联合 UTE 原始五因子 + 波动结构 + 5m/15m；允许有多项反转证据时逆着 UTE 入场。
  'adaptive-ute-v2': (p) => new AdaptiveUteV2Strategy(p as AdaptiveUteV2Params | undefined),
  'major-p1-breakout-v1': (p) => new MajorP1BreakoutStrategy(p as MajorP1BreakoutParams | undefined),
  // Task 81 历史实验版：与 universal-trend-v1 同内核，入场评分下限 0→70。
  // 早期短时段镜像统计曾较好，但后来扩展的夜间时段样本使整体结果明显反转，说明固定 score 阈值存在 regime 敏感性。
  // 保留为对照算法，不把旧样本收益/PF 当作当前性能承诺；新算法改为联合量能、结构与高周期证据决策。
  'strong-trend-v1': (p) =>
    new UniversalTrendStrategy(
      { ENTRY_MIN_SCORE: 70, ...(p as UniversalTrendParams | undefined) },
      {
        id: 'strong-trend-v1',
        name: '强趋势顺随引擎',
        description:
          '强趋势顺随（历史实验版）：通用趋势引擎同一内核，入场评分下限为 70。早期短时段镜像表现较好，' +
          '但扩展到后续时段后表现反转，固定分数线对行情 regime 敏感。保留作对照，不能据此认定高分趋势总是更优；' +
          '离场继承三层（硬止损 1.5% 价格、移动止盈 30/20、持有到 ENDED）。',
      },
    ),
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
