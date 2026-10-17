# trend-trade/strategy —— 算法（策略插件）目录

趋势自动交易（AutoPaperTrader）的「决策层」：每个文件 = 一个可选算法。
基础设施（账户/资金/幂等/二次确认/冷却/强平/MFE 统计）全部在 AutoPaperTrader，
算法只回答「开不开、开哪个方向、什么时候离场」。

```
strategy/
├── types.ts             # TrendStrategy 接口契约（11 个成员；数据结构 StrategyMarketCtx 等）
├── registry.ts          # 注册表：唯一接入入口 + 已注册算法清单（文件头注释）
├── short-swing.ts       # 短周期套利 v1（默认算法，Task 66 顺势化）：确认+评分/ER 门槛+5m 背景分级
│                        #   +脉冲末端不追+确认新鲜窗+冲高落袋；同周期只做第一波（R2 关闭）
├── universal-trend.ts   # 通用趋势引擎 v1（Task 66 复盘定版）：方向选择确认 + 硬止损/移动止盈
└── major-p1-breakout.ts # 重大异动突破 v1：2s 直接消费 MAJOR P1 事件，不依赖趋势池/UTE
```

## 当前算法对比（选型用）

| 维度 | short-swing-v1（默认，Task 66 顺势化） | universal-trend-v1（Task 66 复盘定版） |
| --- | --- | --- |
| 入场 | 1m 确认 + 评分/ER 双门槛 + 5m 分级 | 1m 确认 + 震荡后方向选择证据（突破同向或 ER≥0.3 单边延续） |
| 追高防护 | 脉冲末端不追（短窗已冲 ≥1.2% 拒绝）+ 确认新鲜窗 3 分钟 | 方向选择确认制本身挡住震荡内噪声确认（预判性入场） |
| 5m 背景 | 硬过滤（同向波段/震荡选向/反向不做） | 不设门槛（仅审计留档） |
| 止盈 | SPIKE_TAKE 冲高落袋（0.4%，复盘定版） | 移动止盈：峰值浮盈 15% 后回撤 8% 落袋（TRAIL_TAKE） |
| 止损 | 无硬止损（走弱/ENDED/强平兜底） | STOP_LOSS 硬止损 1.0% 价格（≈20% 保证金 @20x） |
| 走弱离场 | END_PENDING 一根证据即走 | END_PENDING 证据 ≥2 根才走（修复「稍微回调就止损」） |
| 再入场 | 同周期 1 轮（默认，只做第一波） | 同周期 ≤2 轮、需新收盘 K 线 |

### 第三算法：major-p1-breakout-v1

- 仅处理 active + MAJOR + P1 异动，不依赖 20 个标的的 TrendWatch 候选池。
- 专用 2 秒循环；CONFIRMED 突破顺势入场，FALSE 突破退出原方向并在价格继续越过基准线后允许反向；方向性 SPIKE / 待确认突破可用较小保证金即时试探。
- 平台识别使用本地缓存的异动前已收盘 1m K 线：默认回看 20 根，区间幅度 ≤5%、ER ≤0.35，且平台边缘距突破基准 ≤2%；数据不新鲜时不强行判平台。平台确认突破可用标准保证金，趋势加速/非平台突破采用折扣预算。
- 默认标的价格硬止损 1.8%；顺向价格运动达到 2.0% 启动移动止盈，峰值回撤 1.0% 平仓；10 分钟仍无足够顺向扩张则退出。所有价格百分比均非保证金收益率。
- 同一事件无固定分钟冷却，但每次平仓后必须出现新事件证据，单事件默认最多 8 轮；执行层仍限制同币同时只能有一笔 OPEN 仓位。

## 新增算法三步

> ⚡ 速成版（含最小代码骨架、参数进控制台的 3 条铁规则、验证命令）见 `docs/strategy-quickstart.md`。

1. 实现接口：新建 `<algo-name>.ts`，`implements TrendStrategy`（照 short-swing/universal-trend 的样子；
   完整契约与教学示例见 `docs/strategy-interface.md`）。
2. 注册：`registry.ts` 的 `STRATEGY_FACTORIES` 加一行 + 文件头算法清单补一行。
3. 可选：参数要进控制台 → `console-params.ts` 的 `PARAM_DEFS` 注册（**键必须挂
   `strategyId: '<你的 id>'` 归属**，控制台按当前算法过滤展示与校验；不注册 = 使用代码默认参数）。
   改动完成后按铁律 bump 引擎单例（enhanced/engine.ts）。

## 纪律

- short-swing / universal-trend 的方向与评分唯一来源是 UnifiedTrendSignal（vendor universal-trend-engine 的输出）。
- major-p1-breakout-v1 是事件驱动例外：它只判断 MAJOR P1 异动事件与突破结构，不从趋势池接收交易标的；不能把 UTE 趋势确认当成它的入场前提。
- 轮次状态用 `states` map + `bindPersistence` 落库（TrendStrategyState），重启/切换不丢轮次语义。
- 纯模拟；策略绝不接触真实下单（只作用于独立模拟账户 trend-auto-v1）。
