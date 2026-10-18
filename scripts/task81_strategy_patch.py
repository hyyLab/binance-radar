#!/usr/bin/env python3
# Task 81: 注册新策略 strong-trend-v1(强趋势顺随引擎)
# = universal-trend-v1 同一内核,唯一差异 ENTRY_MIN_SCORE 0→70(Task 81 回测定版)
# 改动:①UniversalTrendStrategy 构造器支持身份覆盖(id/name/description 可参数化)
#       ②registry 注册 strong-trend-v1 工厂(默认 ENTRY_MIN_SCORE=70,控制台可覆盖)
import sys

# ---- ① universal-trend.ts:字段声明改为构造器赋值 ----
P1 = '/home/z/my-project/src/lib/market/trend-trade/strategy/universal-trend.ts'
src = open(P1, encoding='utf-8').read()

def anchor(path, src, old, new, count=1):
    if src.count(old) != count:
        print(f'[{path}] ANCHOR FAIL ({src.count(old)}x != {count}): {old[:70]!r}'); sys.exit(1)
    return src.replace(old, new, count)

src = anchor(P1, src, """export class UniversalTrendStrategy implements TrendStrategy {
  readonly id = 'universal-trend-v1';
  readonly name = '通用趋势引擎';
  readonly description =
    'Universal Trend Engine 长周期趋势跟随（Task 68 定版）：1m 确认 + 震荡后方向选择证据' +
    '（区间突破同向或 ER 单边延续）才入场，不做预判性单；确认在就拿满整个周期（走弱不离场，' +
    '等 ENDED/反向），硬止损 1.5% 价格、移动止盈（峰值浮盈 30% 后回撤 20% 落袋）';
""",
"""export class UniversalTrendStrategy implements TrendStrategy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
""")
src = anchor(P1, src, """  constructor(params?: UniversalTrendParams) {
    this.params = withDefaults(params);
  }
""",
"""  /**
   * @param params 参数覆盖（控制台热装配）
   * @param identity 身份覆盖（Task 81：同一内核注册多算法实例用——如 strong-trend-v1
   *   仅 ENTRY_MIN_SCORE 0→70；不传 = 原通用趋势引擎，完全向后兼容）
   */
  constructor(
    params?: UniversalTrendParams,
    identity?: { id?: string; name?: string; description?: string },
  ) {
    this.params = withDefaults(params);
    this.id = identity?.id ?? 'universal-trend-v1';
    this.name = identity?.name ?? '通用趋势引擎';
    this.description =
      identity?.description ??
      'Universal Trend Engine 长周期趋势跟随（Task 68 定版）：1m 确认 + 震荡后方向选择证据' +
        '（区间突破同向或 ER 单边延续）才入场，不做预判性单；确认在就拿满整个周期（走弱不离场，' +
        '等 ENDED/反向），硬止损 1.5% 价格、移动止盈（峰值浮盈 30% 后回撤 20% 落袋）';
  }
""")
open(P1, 'w', encoding='utf-8').write(src)
print('universal-trend.ts OK')

# ---- ② registry.ts:注册 strong-trend-v1 ----
P2 = '/home/z/my-project/src/lib/market/trend-trade/strategy/registry.ts'
src = open(P2, encoding='utf-8').read()

src = anchor(P2, src, """// │ major-p1-breakout-v1│ 重大异动突破│ MAJOR P1 事件驱动；平台突破优先，加速型缩小风险预算
// ────────────────────────────────────────────────────────────────
""",
"""// │ major-p1-breakout-v1│ 重大异动突破│ MAJOR P1 事件驱动；平台突破优先，加速型缩小风险预算
// │ strong-trend-v1     │ 强趋势顺随  │ Task 81：universal-trend 同内核，入场评分下限 0→70（131 笔反向样本正向镜像回测定版）
// ────────────────────────────────────────────────────────────────
""")

src = anchor(P2, src, """  'major-p1-breakout-v1': (p) => new MajorP1BreakoutStrategy(p as MajorP1BreakoutParams | undefined),
};
""",
"""  'major-p1-breakout-v1': (p) => new MajorP1BreakoutStrategy(p as MajorP1BreakoutParams | undefined),
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
""")
open(P2, 'w', encoding='utf-8').write(src)
print('registry.ts OK')
