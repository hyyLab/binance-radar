# PA 整合（pa-action-v1）架构盘点与修改计划

> 任务书要求的「开发前检查」产出。基于 2026-11-11 对 pa_agent 分支代码的实际盘点，非假设。

## 一、现有架构盘点

### 1.1 业务池清单（全池扫描范围——本次接入 5 个）

| # | 池 | 读取方式 | 数据形态 | 排除规则（明确声明，不静默遗漏） |
|---|---|---|---|---|
| 1 | 异动事件池 | `getEnhancedEngine().events(now).active` | 内存 `EnhancedEventDTO[]`（state=ACTIVE） | ENDED 事件排除；`AnomalyEvent` 历史表仅存档不参与 |
| 2 | 趋势观察池 | `trendWatch.snapshot(now).pool` | 内存 `TrendWatchRow[]`（含 UTE phaseV2/direction/score） | `TrendWatchSymbol.status=RETIRED` 退池记录排除 |
| 3 | 主动探针通道 | 同上，`entryChannel='probe'` 的池内条目 | 同上（探针是观察池的入池通道，独立登记来源） | 同上 |
| 4 | 每日热门池 | DB `HotPoolEntry`（date=今天 UTC+8） | 持久化行（VOL/UP/DOWN tags） | 历史日期行排除 |
| 5 | 扫描器宇宙 | `scanner` 单例（涨幅榜 Top20+跌幅榜 Top20+近 4h 异动，上限 200） | 内存（`getSignals()/getLevels()` 含 symbol） | 榜单重建/驱逐的成员随刷新自然退出 |

**明确排除**（写入代码注释与页面「扫描范围」说明）：
- 全量合约行情宇宙（futures collector 631 个 ticker）——是行情源不是业务池；
- 现货/代币化股票（`collector`）——PA 仅针对 U 本位合约；
- `AnomalyEvent` 历史表、RETIRED 观察记录、历史日期热门池。

### 1.2 趋势与信号（UTE）
- `TrendWatchService`（单例经 `EnhancedEngine`）：池 Map（≤20）+ `latestSignals(): UnifiedTrendSignal[]`；信号含 `phase(OBSERVING/CANDIDATE_*/CONFIRMED_*/END_PENDING/ENDED/DATA_UNAVAILABLE)`、`direction`、`trendCycleId={symbol}:{L|S}:{ts}`、`score`、`htf5m/htf15m`、`dataFresh`、`lastBarTime`。
- **可交易相位 = CONFIRMED_UP / CONFIRMED_DOWN**（与现有 4 个策略一致）；扫描仍覆盖全池（观察对象保留展示）。

### 1.3 行情与 K 线
- `KlineStore`（engine.store）：1m 已收盘 K 线，保留 26h，`closedCandles(symbol, lookbackMs, now)` 升序输出；`backfill(symbol)` 可按需回填（PA 对池内但无 K 线缓存的币种按需触发，限频）。
- 5m(96 根)/15m(32 根) 全部由 1m 聚合，完整性校验：桶内 1m 缺失 → 该桶不产出。
- 标记价：`futuresCollector.getTickers()`；tickSize：`futuresCollector.tickSizeOf(symbol)`（PRICE_FILTER，非猜测）。

### 1.4 模拟交易基础设施
- `PaperEngine`：`open({symbol,side,leverage,margin})` 仅现价开仓；`close(positionId)` 全仓平仓；强平巡检 `liquidationCheck`；**`paperEngineFor(name,fee)` 存在缺陷——按单一 key 缓存实例忽略 accountName**（必须修复才能支撑第二个独立账户）。
- `AutoPaperTrader`（账户 trend-auto-v1，10s 主循环 + 1s 事件循环）：单策略槽（registry 切换）、待入场二次确认、退出管理（ENDED/REVERSE_CONFIRMED/策略 evaluateExit）、幂等键 `{cycleId}#R{round}:OPEN`（TrendAutoDecision 唯一约束）、重置时**全表清空** TrendTradeMeta/TrendAutoDecision/TrendPendingEntry/TrendStrategyState。

### 1.5 策略接口
- `TrendStrategy`：observe/evaluateEntry/evaluateExit/nextRound/onOpen/onClose/exportState/importState/bindPersistence；`StrategyEntryVerdict` 仅能表达「现价开仓+margin 比例×riskMultiplier」，**无法表达 LIMIT/STOP_MARKET 指定价入场、TP1/TP2 部分止盈、按止损距离的风险预算**（任务书 §7.4/§7.5/§7.6 明确要求这些能力）。

### 1.6 PA 侧可复用资产（已验证）
- **PA Web（TS，直接移植）**：`src/lib/pa/prompts.ts`（Stage1/Stage2 提示词+extractJson）、`indicators.ts`（EMA20/Wilder ATR14/逐棒特征/featuresToPromptTable）、`api/analyze/route.ts`（normalizeDiagnosis/normalizeDecision/逆势 coherence 拦截、`ZAI.create()` 调用方式）。
- **PA_Agent（Python，移植为 TS 校验器）**：`util/trade_metrics.py`——compute_risk_reward / passes_trader_equation / validate_take_profit_2_geometry / validate_limit_order_k1_freshness。
- **⚠️ 明确偏差（任务书红线 9）**：PA 原版 `adjust_decision_stop_for_tp1_rr_cap`（RR>1 时自动加宽止损）**不移植**；改为「RR < 配置下限 → 直接拒绝计划并记录原因」。TP1 RR > 1 允许（更保守的盈亏比，不惩罚），仅记录。

## 二、文件修改计划

### 2.1 新增（全部独立目录，不重写现有系统）

```
src/lib/pa-integration/
├── types.ts                  # PaCandidateStatus/PaPositionStatus/协同四态/全部 DTO
├── config.ts                 # PA_ACTION 默认参数 + DB 运行时配置读写（后端校验）
├── pool-universe.ts          # RadarPoolSource 适配层 ×5 池 + 合并去重（保留来源）
├── kline-aggregator.ts       # 1m→5m/15m（桶完整性校验，只收已收盘）
├── data-adapter.ts           # PaMarketSnapshot：KFrame(5m/15m)+tickSize+标记价+新鲜度
├── indicators.ts             # 自 PA Web indicators.ts 移植（Bar 类型适配）
├── prompts.ts                # 自 PA Web prompts.ts 移植 + 15m 背景诊断提示词
├── diagnosis-service.ts      # ZAI 两阶段调用 + normalize + coherence + 15m 背景
├── coordination-engine.ts    # UTE×PA 四态（ALIGNED/PULLBACK_DIVERGENCE/STRUCTURAL_CONFLICT/UNCERTAIN）→ ALLOW/WAIT/REJECT
├── trade-plan-validator.ts   # trade_metrics TS 移植 + 任务书 §7.3 十三项校验（禁自动加宽止损）
├── risk-sizing.ts            # RiskBudget→Qty→Notional→Margin（杠杆上限/最小保证金校验）
├── candidate-scanner.ts      # 全池扫描→去重→快速筛选→候选状态机（DISCOVERED→…）
├── analysis-queue.ts         # 异步 AI 队列（并发≤2、{symbol}:{bar5m}:{promptVer} 幂等、冷却、超时）
├── pa-trader.ts              # PaActionTrader 执行循环：待入场单触发（MARKET/LIMIT/STOP_MARKET）、止损/TP1/TP2/趋势失效退出、保守同 K 线规则
├── repo.ts                   # ensurePaSchema（幂等 CREATE TABLE IF NOT EXISTS + PRAGMA 补列）+ Pa* 表读写
├── scheduler.ts              # 单例装配：扫描循环(60s)/执行循环(5s)/AI 队列 worker，互不阻塞
└── stats.ts                  # 收益/胜率/PF/最大回撤/费用/平均持仓时长
src/app/pa-analysis/page.tsx           # 五区域页面（概览/候选列表/详情/自动交易/历史+配置）
src/app/api/pa-analysis/{candidates,pools,summary,analyze,history,trades,orders,config,strategy,orders/[id]/cancel,trades/[id]/close}/route.ts
src/lib/market/trend-trade/strategy/pa-action-v1.ts   # registry 登记（防御性 stub）
scripts/pa-integration-tests.mjs        # 集成/回归测试脚本
```

### 2.2 修改现有文件（最小兼容性扩展）

| 文件 | 改动 | 理由 |
|---|---|---|
| `paper.ts` | ① `paperEngineFor` 改为按 accountName 缓存（bump v3，trend-auto 行为不变）；② 新增 `closePartial(positionId, qty)`（按比例释放保证金、openFee 按比例结转、PaperTrade 留痕） | 独立账户 pa-auto-v1 + TP1 部分止盈（§7.4/§7.6） |
| `strategy/registry.ts` | 登记 `pa-action-v1`：evaluateEntry 恒 want=false 并指引「由 /pa-analysis 独立调度器执行」 | 遵守注册表规范；防止旧主循环误用 PA 策略现价开仓 |
| `prisma/schema.prisma` | 追加 Pa* 模型（仅 generate，不 db push 不 reset） | Prisma client 类型 |
| `src/lib/market/enhanced/engine.ts` | 不改。PA 经 `getEnhancedEngine()` 只读取池/信号/K线/事件 | 零侵入 |

**不改**：AutoPaperTrader 主循环、现有 4 个策略、trend-watch、enhanced 探测器、现有页面/API。

### 2.3 关键设计决策（任务书内部张力的裁决）

1. **pa-action-v1 不进 AutoPaperTrader 主循环**：任务书 §7.2 禁止交易主循环同步等 AI；§7.4/§7.6 要求的 LIMIT/STOP_MARKET 待入场单与 TP1/TP2 部分止盈超出 `StrategyEntryVerdict/StrategyExitVerdict` 表达能力；§12 要求「新旧策略同时运行、PA 退出不碰他仓」。AutoPaperTrader 是单策略槽+全表清空重置，复用必然互相污染。**裁决**：独立 `PaActionTrader`（专用调度器+独立账户+独立状态表），registry 登记 stub 保持规范可见。
2. **独立账户 `pa-auto-v1`**（费率 0.02% 同 trend-auto）：与 trend-auto-v1、default 手动盘资金/持仓全隔离。
3. **成交假设（明确声明，不冒充真实成交）**：触发判定用「已收盘 1m K 线高低价 + 当前标记价」；成交价 = 触发时刻标记价（决策时点价，无未来数据）；滑点按 bps 计入净盈亏统计口径（与 trend-auto 相同的保守口径）。LIMIT 多单在标记价≤限价时成交（按标记价，不优于市价的假设）；同一根 1m K 线同时触及止损与止盈 → **保守判止损**。
4. **AI 失败/WAIT/REJECT 绝不降级 UTE-only 开仓**（红线 7）；AI 不越权改程序判定（coherence + validator 双闸）。
5. **数据库增量**：`ensurePaSchema` 幂等建表（模式同 ensureTrendTradeSchema），现有表/数据零改动；禁 db:push/db:reset。
6. **幂等**：AI 分析键 `{symbol}:{bar5mOpenTime}:{promptVersion}`；订单/开仓决策键 `{symbol}:{direction}:{bar5mOpenTime}:OPEN` 唯一约束兜底；页面刷新/重扫/AI 重试不重复开仓。

### 2.4 默认风险参数（可配置，后端校验）

`riskPerTradePct=0.5`、`maxPositions=3`、`maxTotalRiskPct=2`、`leverage=10（上限≤20）`、`tp1CloseRatio=0.5`、`breakevenAfterTp1=false`、`orderExpiryMs=30min`、`entryMaxDeviationPct=0.3`、`stopCooldownMs=30min`、`analysisCooldownMs=15min`、`aiConcurrency=2`、`minRiskReward=1.0`、`feeRate=0.02%`、`slippageBps=2`。

### 2.5 实施顺序（=任务书 §十五）

T4 数据层（池接口/聚合/DB）→ T5 分析层（Stage1/2+协同+校验器）→ T6 扫描层（候选+队列）→ T7 执行层（PaperEngine 扩展+PaActionTrader）→ T8 页面/API → T9 测试与验收 → T10 报告与推送。每步带对应测试后再进下一步。
