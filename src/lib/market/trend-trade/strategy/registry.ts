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
// │ strong-trend-v1     │ 强趋势顺随  │ Task 81：universal-trend 同内核，入场评分下限 0→70（131 笔反向样本正向镜像回测定版）
// ────────────────────────────────────────────────────────────────
// 默认算法保持 short-swing-v1（Task 62 用户定版：UTE 先上架可选，控制台暂用
// 其代码默认参数；切换在 UI 算法下拉进行，切换前自动平仓清场由 control API 负责）。

import { ShortSwingStrategy, type ShortSwingParams } from './short-swing';
import { UniversalTrendStrategy, type UniversalTrendParams } from './universal-trend';
import { MajorP1BreakoutStrategy, type MajorP1BreakoutParams } from './major-p1-breakout';
import type { StrategyDescriptor, TrendStrategy } from './types';

/** 策略工厂表（id → 实例构造；params 为已校验的覆盖项，键随策略自解释） */
const STRATEGY_FACTORIES: Record<string, (params?: Record<string, unknown>) => TrendStrategy> = {
  'short-swing-v1': (p) => new ShortSwingStrategy(p as ShortSwingParams | undefined),
  'universal-trend-v1': (p) => new UniversalTrendStrategy(p as UniversalTrendParams | undefined),
  'major-p1-breakout-v1': (p) => new MajorP1BreakoutStrategy(p as MajorP1BreakoutParams | undefined),
  // Task 81 数据定版：与 universal-trend-v1 唯一差异 = ENTRY_MIN_SCORE 0→70（只做五因子近乎全亮的强确认）。
  // 回测依据（131 笔反向样本的正向镜像）：score≥70 子集 20 笔 +57.57U / PF 3.37（全量 131 笔 +27.53 / PF 1.17），
  // 时间三分 -1.3/+12.4/+46.5（免疫前段亏损潮）；score≥70 内止损档位无敏感性 → 离场三层原样继承。
  // ⚠️ 样本为 4 小时单 regime，阈值存在过拟合风险（用户知情接受），跨 regime 后复校。
  'strong-trend-v1': (p) =>
    new UniversalTrendStrategy(
      { ENTRY_MIN_SCORE: 70, ...(p as UniversalTrendParams | undefined) },
      {
        id: 'strong-trend-v1',
        name: '强趋势顺随引擎',
        description:
          '强趋势顺随（Task 81 数据定版）：通用趋势引擎同一内核，唯一差异 = 入场评分下限 0→70' +
          '——只做五因子证据近乎全亮的强确认。回测依据（131 笔反向样本正向镜像）：score≥70 子集 20 笔 ' +
          '+57.57U、PF 3.37（全量 +27.53、PF 1.17），时间三分 -1.3/+12.4/+46.5（免疫前段亏损潮）；' +
          '离场继承三层（硬止损 1.5% 价格、移动止盈 30/20、持有到 ENDED）。样本为 4 小时单 regime，' +
          '阈值存在过拟合风险，跨 regime 后需复校',
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
