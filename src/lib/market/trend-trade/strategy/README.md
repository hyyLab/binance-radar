# trend-trade/strategy —— 算法（策略插件）目录

趋势自动交易（AutoPaperTrader）的「决策层」：每个文件 = 一个可选算法。
基础设施（账户/资金/幂等/二次确认/冷却/强平/MFE 统计）全部在 AutoPaperTrader，
算法只回答「开不开、开哪个方向、什么时候离场」。

```
strategy/
├── types.ts             # TrendStrategy 接口契约（11 个成员；数据结构 StrategyMarketCtx 等）
├── registry.ts          # 注册表：唯一接入入口 + 已注册算法清单（文件头注释）
├── short-swing.ts       # 短周期套利 v1（默认算法）：确认+评分/ER 门槛+5m 背景分级+冲高落袋
└── universal-trend.ts   # 通用趋势引擎 v1（最开始的 UTE）：确认即顺势、确认在就拿满、无冲高落袋
```

## 当前算法对比（选型用）

| 维度 | short-swing-v1（默认） | universal-trend-v1 |
| --- | --- | --- |
| 入场 | 1m 确认 + 评分/ER 双门槛 | 1m 确认即入场（纯确认制） |
| 5m 背景 | 硬过滤（同向波段/震荡选向/反向不做） | 不设门槛（仅审计留档） |
| 冲高落袋 | 有（SPIKE_TAKE 短窗脉冲） | 无（确认在就拿满周期） |
| 离场 | 冲高先落袋、走弱再走 | 走弱先走（END_PENDING 同周期） |
| 再入场 | 同周期 ≤2 轮、需新收盘 K 线 | 同（防磨损护栏两算法一致） |

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
