# trend-trade/strategy —— 算法（策略插件）目录

趋势自动交易（AutoPaperTrader）的「决策层」：每个文件 = 一个可选算法。
基础设施（账户/资金/幂等/二次确认/冷却/强平/MFE 统计）全部在 AutoPaperTrader，
算法只回答「开不开、开哪个方向、什么时候离场」。

```
strategy/
├── types.ts             # TrendStrategy 接口契约（含可选生命周期覆盖；数据结构 StrategyMarketCtx 等）
├── registry.ts          # 注册表：唯一接入入口 + 已注册算法清单（文件头注释）
├── short-swing.ts       # 短周期套利 v1（默认算法）：确认+评分/ER 门槛+5m 背景分级
│                        #   +脉冲末端不追+首轮新鲜窗+冲高落袋；走弱先走、同周期走强可再入场（≤2 轮）
├── universal-trend.ts   # 通用趋势引擎 v1（Task 68 长周期定版）：确认+震荡后方向选择证据才入场；
│                        #   确认在就拿满周期（走弱不离场）；硬止损 1.5% 价格+移动止盈（峰值 30% 回撤 20% 落袋）
└── adaptive-ute-v2.ts   # 自适应 UTE v2：原始五因子 + 波动/假突破 + 5m/15m；顺势与多证据反转分流
```

## 当前算法对比（选型用）

| 维度 | short-swing-v1（默认） | universal-trend-v1（Task 68 长周期定版） |
| --- | --- | --- |
| 入场 | 1m 确认 + 评分/ER 双门槛 + 5m 分级 | 1m 确认 + 震荡后方向选择证据（突破同向或 ER≥0.3 单边延续） |
| 追高防护 | 脉冲末端不追（短窗已冲 ≥1.2% 拒绝）+ 首轮新鲜窗 3 分钟 | 方向选择确认制本身挡住震荡内噪声确认（预判性入场） |
| 5m 背景 | 硬过滤（同向波段/震荡选向/反向不做） | 不设门槛（仅审计留档） |
| 止盈 | SPIKE_TAKE 冲高落袋（0.4%，复盘定版） | 移动止盈：峰值浮盈 30% 后回撤 20% 落袋（TRAIL_TAKE） |
| 止损 | 无硬止损（走弱/ENDED/强平兜底） | STOP_LOSS 硬止损 1.5% 价格（≈30% 保证金 @20x） |
| 走弱离场 | END_PENDING 一根证据即走 | 不离场（Task 68 长周期：持有到 ENDED/反向确认） |
| 再入场 | 同周期 ≤2 轮、需新收盘 K 线（走弱离场后走强可再进） | 同周期 ≤2 轮（长周期默认下休眠：走弱不离场即无同周期再入场） |

## adaptive-ute-v2（测试版）

不修改 UTE 方向或评分公式。原始 UTE 五因子会透传到 `UnifiedTrendSignal.uteEvidence`，并与 ER、影线、假突破、波动状态及 5m/15m 背景共同决定顺势或反转入场。反转模式必须有成熟度和至少两项反转线索；不会单纯因为 score ≥70 就逆势，也没有按时钟划分“夜间交易”禁区。规则、初始阈值和明日观察指标见 [`docs/adaptive-ute-v2-test-plan.md`](../../../../../docs/adaptive-ute-v2-test-plan.md)。

## 新增算法三步

> ⚡ 速成版（含最小代码骨架、参数进控制台的 3 条铁规则、验证命令）见 `docs/strategy-quickstart.md`。

1. 实现接口：新建 `<algo-name>.ts`，`implements TrendStrategy`（照 short-swing/universal-trend 的样子；
   完整契约与教学示例见 `docs/strategy-interface.md`）。
2. 注册：`registry.ts` 的 `STRATEGY_FACTORIES` 加一行 + 文件头算法清单补一行。
3. 可选：参数要进控制台 → `console-params.ts` 的 `PARAM_DEFS` 注册（**键必须挂
   `strategyId: '<你的 id>'` 归属**，控制台按当前算法过滤展示与校验；不注册 = 使用代码默认参数）。
   改动完成后按铁律 bump 引擎单例（enhanced/engine.ts）。

## 纪律

- 方向与评分唯一来源是 UnifiedTrendSignal（vendor universal-trend-engine 的输出），
  算法**绝不自建第二套方向/评分逻辑**。
- 轮次状态用 `states` map + `bindPersistence` 落库（TrendStrategyState），重启/切换不丢轮次语义。
- 纯模拟；策略绝不接触真实下单（只作用于独立模拟账户 trend-auto-v1）。
