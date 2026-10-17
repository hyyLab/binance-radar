# 加一个新算法 · 速成版（一页）

> 详细原理/教学示例看 `docs/strategy-interface.md`（807 行）。本文只给最短可操作路径。
> 算法目录：`src/lib/market/trend-trade/strategy/`

## 0. 算法在哪

```
src/lib/market/trend-trade/strategy/
├── types.ts             # TrendStrategy 接口（你要 implements 的契约）
├── registry.ts          # 注册表（新算法在这里登记一行，UI 下拉自动出现）
├── short-swing.ts       # 短周期套利（默认算法，最完整的参考实现）
├── universal-trend.ts   # 通用趋势引擎（最短骨架，复制它起步最快）
└── major-p1-breakout.ts # 重大异动突破（事件驱动：直接 MAJOR P1，不依赖趋势池）
```

## 1. 写算法文件（复制 universal-trend.ts → 你的算法.ts）

必改 3 个字段：

```ts
export class MyAlgoStrategy implements TrendStrategy {
  readonly id = 'my-algo-v1';        // 唯一 id，会持久化进 DB，定了就别改
  readonly name = '我的算法';          // UI 下拉显示名
  readonly description = '一句话说明'; // 下拉切换确认框里显示
```

核心只有两个决策方法，其余照抄骨架：

| 方法 | 你要回答的问题 | 不需要时怎么写 |
|---|---|---|
| `evaluateEntry(signal, ctx)` | 开不开仓？方向？ | 返回 `{ want: false, side: null, modeTag: '-', reason: '...' }` |
| `evaluateExit(input)` | 要不要离场？ | 返回 `{ exit: false, reason: null, detail: '' }` |
| `observe()` | （每 tick 喂价） | 空实现即可 |
| `nextRound / onOpen / onClose / exportState / importState / bindPersistence` | 轮次状态 | 照抄骨架，不用理解也能跑 |

参数定义：文件顶部导出一个常量（如 `export const MY_ALGO = { ... }`），
构造器 `withDefaults` 合并覆盖——照抄 universal-trend.ts 的 `UNIVERSAL_TREND` 写法。

## 2. 注册一行（registry.ts）

```ts
import { MyAlgoStrategy, type MyAlgoParams } from './my-algo';

const STRATEGY_FACTORIES = {
  'short-swing-v1': ...,
  'universal-trend-v1': ...,
  'major-p1-breakout-v1': ...,
  'my-algo-v1': (p) => new MyAlgoStrategy(p as MyAlgoParams | undefined),  // ← 加这行
};
```

文件头注释的「已注册算法清单」表补一行。到这里 UI 下拉已经有你的算法了。

## 3. 参数进控制台（可选，console-params.ts）

`PARAM_DEFS` 数组里加条目，**每个参数一条**：

```ts
{
  key: 'MY_ALGO_ENTRY_MIN_SCORE',            // 规则②：与 MY_ALGO 参数常量的键完全一致
  scope: 'strategy', strategyId: 'my-algo-v1', // 规则③：填你的算法 id
  group: '入场门槛',                           // 控制台分组标题（新分组会自动出现）
  label: '评分下限',
  type: 'number',                             // 'number' | 'boolean'
  default: MY_ALGO.ENTRY_MIN_SCORE,           // 代码默认值
  min: 0, max: 100, step: 1,                  // number 型必填范围
  desc: '这个参数控制什么。',                    // 控制台说明行
  effect: '调大 → …；调小 → …',                // 调节效果提示
},
```

**三条铁规则（踩了会静默坏）：**

1. **key 全局唯一**。`DEF_BY_KEY` 按键名建全局索引，后注册的覆盖先注册的——如果和
   short-swing 撞名，短周期套利的同名参数会被控制台拒绝（报「不属于当前算法」）。
   做法：参数常量的键本身就带算法前缀（如 `MY_ALGO_ENTRY_MIN_SCORE`），从根上不撞。
2. **key 必须 = 参数常量的键**。控制台保存的值会原样传给你的构造器
   （`createStrategy(id, params)` → `withDefaults({...MY_ALGO, ...params})`），
   键对不上 = 改了不生效。
3. **strategyId 必须填你的算法 id**。控制台只展示/校验「当前激活算法」的参数，
   填错 = 永远不显示。

不注册参数也完全能跑（用代码默认值）。

## 4. 上线：bump 引擎单例（不重启 server！）

运行中的 auto-trader 是旧模块图的实例，必须让它退役重建。`src/lib/market/enhanced/engine.ts`：

- 当前 main 的全局键为 `__binanceRadarEnhanced_v19`；本次新增算法行为后 bump 到 `v20`（类型声明、get/reset 存取及 v19 遗留交接链均要更新）
- 头部版本注释链加一行 v20 说明

事件驱动策略是特殊入口：普通算法消费 `UnifiedTrendSignal`；`major-p1-breakout-v1` 通过 `evaluateAnomalyEntry(event, ctx)` 和 `AutoTraderDeps.getEvents` 直接消费活动异动事件，绕过趋势池、同币固定冷却与下一根 K 线二次确认；执行仍复用 AutoPaperTrader 的模拟资金和成交层。

保存后热重载自动生效。**验证：**

```bash
curl -s http://localhost:3000/api/trend-trading | jq '.config.strategies'
# 出现 {"id":"my-algo-v1","name":"我的算法",...} 即注册成功
```

UI：算法下拉出现新名字 → 确认框切换 → 控制台出现你的参数分组 →
改一个值保存 → 日志出现「参数控制台：策略参数已更新并热应用」→ 生效。

## 参数保存后去了哪（链路，排障用）

```
控制台保存 → control API sanitizeRuntimeParams（未知键/不属于当前算法 → 直接 400）
          → DB TrendAutoConfig.strategyParamsJson = { "my-algo-v1": { ...覆盖项 } }
          → auto-trader applyStrategy：解析 → createStrategy(id, params) 热重装配（无需重启）
```

DB 里只存覆盖项，删掉某键 = 回落代码默认；传 `{}` = 整体回默认。
