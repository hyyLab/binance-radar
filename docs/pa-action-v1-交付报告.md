# pa-action-v1 交付报告（PA_Agent × binance-radar 整合）

> 分支：`pa_agent` · 交付日期：2026-11-11 · 任务书：binance-radar × PA_Agent 整合开发任务书（pa-action-v1）
> 结论先行：**验收 A/B/C/E 全部实测通过；验收 D 的执行层逻辑实测通过、全自动开仓依赖真实 ALLOW 信号出现（当前市场四态判为 WAIT/REJECT，属设计内保守行为）；验收 F 即本报告。**

---

## 1. 修改和新增的文件清单

### 新增（17 个源文件 + 2 个脚本 + 1 个文档）

```
src/lib/pa-integration/            # PA 整合核心（全部独立新目录，零侵入现有系统）
├── types.ts                       # 全部类型（候选状态机/协同四态/计划/订单/持仓元数据）
├── config.ts                      # 参数常量 + DB 运行时配置（loadPaConfig/savePaConfig/validatePaConfigPatch 后端校验）
├── pool-universe.ts               # 全池统一读取接口（5 池适配 + 合并去重保留来源）
├── kline-aggregator.ts            # 1m→5m/15m 聚合（桶完整性校验）
├── data-adapter.ts                # 行情快照（KlineStore 只读 + tickSize + 新鲜度 WAIT）
├── market-snapshot.ts             # 标记价/tickSize 读取（globalThis 别名动态解析）
├── indicators.ts                  # EMA20/Wilder ATR14/逐棒特征（自 PA Web 移植，算法逐行一致）
├── prompts.ts                     # Stage1/Stage2 提示词 + 15m 背景（自 PA Web 移植）
├── diagnosis-service.ts           # ZAI 两阶段调用 + 归一化 + 逆势 coherence 拦截
├── coordination-engine.ts         # UTE×PA 四态协同（核心新增）
├── trade-plan-validator.ts        # trade_metrics TS 移植 + 任务书 §7.3 十三项校验
├── risk-sizing.ts                 # 风险预算仓位（RiskBudget→Qty→Notional→Margin）
├── candidate-scanner.ts           # 全池扫描 + 快速筛选 + 候选状态机
├── analysis-queue.ts              # 异步 AI 队列（并发≤2、幂等、冷却、超时留痕）
├── pa-trader.ts                   # PaActionTrader 执行层（触发/止损/TP1/TP2/趋势失效）
├── repo.ts                        # ensurePaSchema 幂等建表 + 全部表读写
├── scheduler.ts                   # 单例调度（扫描 60s/队列泵 10s/执行 5s 三循环）
├── stats.ts                       # 胜率/PF/回撤/费用/持仓时长
└── api-helpers.ts                 # API 公共辅助
src/app/pa-analysis/page.tsx       # 五区域页面（概览/候选/详情/自动交易/历史+配置）
src/app/api/pa-analysis/…          # 9 个 API 路由（见 §8）
src/components/pa/kline-chart.tsx  # 5m/15m K 线图 + EMA20 + 计划价格线（lightweight-charts v5）
src/lib/market/trend-trade/strategy/pa-action-v1.ts  # 注册表登记（防御性 stub，见 §3.3）
scripts/pa-integration-tests.ts    # 集成/回归测试（60 断言）
scripts/pa-live-analyze.ts         # 单标的实时分析验证工具
docs/pa-integration-plan.md        # 开发前架构盘点与修改计划（任务书 §二要求）
```

### 修改（4 个，最小兼容性扩展）

| 文件 | 改动 | 现有行为影响 |
|---|---|---|
| `src/lib/market/paper.ts` | ① `paperEngineFor` 按 accountName 缓存（bump v3）；② 新增 `closePartial(positionId, qty)` | ① 修复了旧实现忽略 accountName 的缺陷；`trend-auto-v1`/`default` 解析结果不变；② 纯新增方法，旧调用零影响 |
| `src/lib/market/scanner.ts` | 新增只读 `getUniverseSymbols()` 与 `stop()`；单例 key bump v2（重建时先停旧实例定时器） | 扫描逻辑零改动；宇宙缓存 ~10 分钟自愈 |
| `src/lib/market/trend-trade/strategy/registry.ts` | 登记 `pa-action-v1`（防御性 stub） | 原 4 策略注册/切换/运行完全不变 |
| `prisma/schema.prisma` | 追加 5 个 Pa* 模型（仅类型生成） | 未执行 db push/migrate，现有库零改动 |

**未修改**：AutoPaperTrader 主循环、trend-watch、enhanced 引擎、原有 4 个策略、原有页面与 API。

## 2. 接入的 Radar 池子及读取方式（验收 A）

| 池 | poolId | 读取方式 | 排除规则 |
|---|---|---|---|
| 异动事件池 | `anomaly-events` | `getEnhancedEngine().events(now).active`（内存 DTO） | ENDED 事件排除；`AnomalyEvent` 历史表仅存档 |
| 趋势观察池 | `trend-watch` | `trendWatch.snapshot(now).pool`（内存，含 UTE 相位/方向/评分） | `TrendWatchSymbol.RETIRED` 排除；候选 TTL 过期自然退池 |
| 主动探针池 | `probe` | 同上（`entryChannel='probe'` 条目独立登记来源） | 同上 |
| 每日热门池 | `hot-daily` | DB `HotPoolEntry`（date=当天 UTC+8） | 历史日期行排除 |
| 扫描器宇宙 | `scanner-universe` | `scanner.getUniverseSymbols()`（新增只读接口） | 榜单重建/驱逐随刷新自然退出 |

**明确排除**（页面「扫描范围」同步展示）：全量合约行情宇宙（631 个 ticker，是行情源不是业务池）、现货/代币化股票（非 USDT 计价后缀规整层剔除并计数）、历史记录类数据。

实测（2026-11-11 18:50 UTC+8）：`anomaly-events=0 hot-daily=123 probe=0 scanner-universe=0 trend-watch=0 → 去重 122`——trend-watch/scanner/anomaly 为 0 是**冷启动后尚未重建**（观察池 TTL 30min 已过期属正确退池，榜单/异动事件随运行自愈），非读取故障（各池 API 均 200）。

## 3. pa-action-v1 策略运行流程

```
60s 扫描循环：5 池读取 → 合并去重（保留来源）→ 快速筛选（UTE 确认相位+dataFresh+无持仓/待入场+冷却）
   → 投递异步 AI 队列（候选状态机：DISCOVERED→ELIGIBLE→PA_ANALYZING→…）
10s 队列泵：并发 ≤2 拉起分析任务（AI 幂等键 {symbol}:{barTime5m}:{promptVersion}）
   每任务：行情快照(WAIT 校验) → Stage1(5m 主诊断+15m 背景) → 四态协同
        → ALLOW 才进 Stage2 → Validator(13 项) → 风险预算仓位 → 创建待入场单
5s 执行循环：强平巡检 → 待入场单触发（MARKET 偏差/LIMIT 触价/STOP_MARKET 突破）→
   止损(保守优先) → TP1 部分止盈 → TP2 清仓 → UTE 趋势失效退出 → 全程留痕
```

**为何不进 AutoPaperTrader 主循环**（架构裁决，已写入 docs/pa-integration-plan.md §2.3）：任务书 §7.2 禁止交易主循环同步等 AI；§7.4/§7.6 的 LIMIT/STOP_MARKET 指定价入场与 TP1/TP2 部分止盈超出 `StrategyEntryVerdict/StrategyExitVerdict` 表达能力；§12 要求新旧策略同时运行互不接管（AutoPaperTrader 是单策略槽 + 重置全表清空）。因此 pa-action-v1 由独立 `PaActionTrader` 调度器执行（独立账户 + 独立状态表），registry 登记为防御性 stub——趋势自动账户误选它时 `evaluateEntry` 恒拒绝并给出指引，绝不走 UTE 现价开仓路径。

## 4. UTE × PA 协同判断规则（coordination-engine.ts）

保留双方原始判断（UTE 信号与 PA 诊断全量随分析记录落库，绝不改写），四态判定：

| 状态 | 判定条件（程序规则，AI 输出只是输入） | 决策 |
|---|---|---|
| **ALIGNED** | UTE 确认方向 = PA 5m 方向，15m 背景不反对，PA 形态属趋势通道（非区间/不可读/spike 高潮），market_phase=stable | ALLOW → Stage2 |
| **PULLBACK_DIVERGENCE** | PA 短期反向，但结构破坏证据 <2 项（15m 仍支持原方向 / 形态仍属顺向趋势通道 / 无高置信 AlwaysIn 反向） | WAIT（只跟踪，**绝不反向开仓**） |
| **STRUCTURAL_CONFLICT** | ≥2 项独立证据：15m 背景明确反向 + PA 形态脱离顺向通道 / AlwaysIn 反向置信 ≥70 / ≥2 根趋势级反向棒 | REJECT（冷却；若同向 PA 持仓存在 → 按 PA_STRUCTURE_INVALID 退出） |
| **UNCERTAIN** | 诊断置信 <45 / 闸门失败 / neutral / 5m 同向但 15m 反向 / 形态切换中 / spike 禁追 / 数据缺失 | WAIT |

AI 不越权：coherence 拦截（逆势方案强制不下单）+ 协同/Validator 均为纯程序规则；**AI 失败绝不降级 UTE-only**（AI_FAILED 留痕，候选回 WAITING_CONFIRMATION）。

## 5. 模拟开仓与退出机制

**成交假设（明确声明，不冒充真实成交）**：触发判定用「已收盘 1m K 线高低价 + 当前标记价」；成交价 = 触发时刻标记价（决策时点价，无未来数据）；滑点按 bps 计入净盈亏统计口径；1m 内部路径未知 → **同一根 K 线同时触及止损与止盈，保守判止损**。

- **MARKET**：创建时与触发时双重偏离校验（默认 0.3%），超限取消不追价。
- **LIMIT**：多头等标记价 ≤ 限价成交；已错过（K1 freshness）/过期/趋势失效 → 取消。
- **STOP_MARKET**：多头等标记价 ≥ 触发价；触发前失效 → 取消。
- **仓位**：`Qty = 权益×riskPerTrade% / |entry−SL|`（默认 0.5%/笔），总敞口 ≤2%，杠杆 ≤cap，保证金+费 > 余额即拒绝（不变通）。
- **退出优先级**：止损（价格优先）→ 趋势失效（UTE ENDED 周期精确匹配 / REVERSE_CONFIRMED / PA 结构冲突）→ TP1（默认平 50%，一次性）→ TP2（清剩余）。TP1 后移保本默认**关闭**（不擅改 PA 原始计划，配置可开）。
- **幂等**：待入场单 id=`{symbol}:{direction}:{barTime5m}`（DB 主键）；同 symbol ≤1 ACTIVE 单 + 1 OPEN 仓；重扫/刷新/重试不重复开仓。

## 6. 数据库迁移内容（增量、零破坏）

新增 5 张表（`ensurePaSchema` 幂等 `CREATE TABLE IF NOT EXISTS` + 命名索引，boot/API 入口自动执行）：

| 表 | 用途 |
|---|---|
| `PaActionConfig` | 运行配置单行（id='pa-action-v1'，页面可调、后端校验） |
| `PaCandidate` | 全池候选状态机（来源池 JSON/UTE 快照/协同结果/原因） |
| `PaAnalysis` | AI 分析全链路留档（UTE 快照/Stage1/15m/协同证据/原始计划/校验清单/耗时/错误；id=分析幂等键） |
| `PaPendingOrder` | 待入场单（三类触发/状态机/计划追溯 planId→PaAnalysis） |
| `PaPositionMeta` | 持仓元数据（TP1/TP2/保本/已实现盈亏/退出原因；positionId=PaperPosition.id） |

**未动**：现有全部表与数据（PaperAccount/PaperPosition/PaperTrade/TrendWatchSymbol/TrendTradeMeta/TrendAutoDecision/TrendPendingEntry/TrendStrategyState/HotPoolEntry/AnomalyEvent）；未执行 `db push`/`migrate reset`；`.env` 与 `db/custom.db` 未提交。实测数据完整性：原 trend-auto-v1 账户、交易记录、回归 API 全部正常。

## 7. 测试结果及未通过项目

**单元/集成测试 `scripts/pa-integration-tests.ts`：60 通过 / 0 失败**
- A1 K 线聚合（OHLC 数学/缺失桶丢弃/升序/5m+15m）
- A2 协同四态（任务书 §13.3 全场景含 SHORT 镜像/追高潮防线/UTE 无方向兜底）
- A3 Validator 13 项（几何/RR/交易者方程/tick/K1 freshness/偏离/订单语义/**禁自动加宽止损**——断言输入计划对象未被修改）
- A4 风险预算（公式/总敞口/余额不足拒绝）
- A5 JSON 提取与归一化容错
- B1 全池读取（5 池接入、非单一候选池）
- B2/B3 全部 API 200 + 非法配置 400
- B5 原系统回归（`/`、`/api/trend-trading`、`/api/enhanced/trends`、`/api/market/tickers` 全部 200 结构正常）

**真实链路验证（`scripts/pa-live-analyze.ts`，真实行情 + 真实 ZAI 调用）**
- BTCUSDT：快照 96×5m+32×15m（tick=0.1 取自 PRICE_FILTER）→ Stage1 `normal_channel/neutral`（14.4s）→ 15m 背景 → 协同 **UNCERTAIN/WAIT**（PA 方向中性）
- ZECUSDT（模拟 UTE 多）：Stage1 `broad_channel/bearish` + 15m `bearish` → **STRUCTURAL_CONFLICT/REJECT**（2 项独立证据：15m 反向 + AlwaysIn 高置信反向——可追溯证据逐条输出）
- ZECUSDT（模拟 UTE 空）：PA `transitioning` → **UNCERTAIN/WAIT**（形态切换中）
- Stage2+Validator 链路（真实模型输出）：LIMIT SHORT entry=1044.6/sl=1049.5/tp1=1023.8/tp2=1008.5/胜率估计 65% → 11/12 过，**DEVIATION 0.872%>0.3% 拒单**（拒追价保护真实生效）

**执行层实测（pa-auto-v1 隔离账户受控测试，已复位）**
- `closePartial`：开仓 BTCUSDT LONG（qty=0.00068@73479.3, margin 5）→ 50% 部分平（仓位 qty/margin/openFee 按比例缩减、保持 OPEN）→ 全平 → 流水 pnl 合计与分笔一致 → 账户复位 100U

**未通过/未覆盖项（如实声明）**：
1. **验收 D 的「全自动端到端开仓」未在真实市场触发**——当前市场协同判 WAIT/REJECT（设计内保守行为，绝不为验证而放行）。执行层各环节（触发/止损/TP/趋势失效）逻辑已由单元测试 + 受控实测覆盖；建议策略启用后随市场自然出现 ALIGNED 信号时观察首笔自动开仓。
2. B4 真实 AI 分析历史记录未产生——同上（无 CONFIRMED_* 标的 + 协同未放行即不落 OK 记录，留痕为 AI_FAILED/STALE 或无记录）。
3. PA_Agent 原版「TP1 RR=1:1 自动加宽止损」**被任务书红线 9 明确禁止**，未移植；RR<minRR 直接拒绝并留痕。

## 8. 页面访问方式和启动命令

- **页面**：`/pa-analysis`（radar 同端口，无独立服务）；API 前缀 `/api/pa-analysis/*`：
  `GET summary | candidates | pools(含于 summary) | analyze(POST) | history | history/[id] | trades | orders | config(GET/PUT) | strategy(POST start|pause|resume) | orders/[id]/cancel(POST) | trades/[id]/close(POST)`
- **启动**（沙箱/开发）：
  ```bash
  cd binance-radar
  export DATABASE_URL="file:/home/z/my-project/binance-radar/db/custom.db"
  bunx next dev -p 3001        # 或 bun run dev（默认 3000）
  ```
  首次访问任意 `/api/pa-analysis/*` 即自动建表 + 播种配置 + 拉起三循环；页面默认**停机**（enabled=0），点「启用策略」后开始自动交易。
- **测试**：`bun scripts/pa-integration-tests.ts`（加 `--unit` 只跑纯逻辑）；单标的验证：`bun scripts/pa-live-analyze.ts BTCUSDT up`。

## 9. 当前已知问题和后续建议

**已知问题**
1. PA 每次完整分析 = 2×Stage1 + 1×Stage2 ≈ 3 次模型调用（约 25-45s/标的）；候选量大时按冷却（15min）与并发（2）节流，热点轮动快时可能持续排队。
2. 15m 背景调用失败时按 UNCERTAIN/WAIT 处理（不阻塞 5m 主诊断）——高周期背景缺失会显著降低放行率（保守设计）。
3. 冷启动后 trend-watch/scanner/anomaly 三池需要 5-10 分钟自愈填充（TTL 与榜单重建周期所致），期间全池扫描主要覆盖 hot-daily。
4. 回调结束再入场（PULLBACK_DIVERGENCE→ALIGNED 的新证据确认）依赖下一次 5m 收盘后的新分析（幂等键按 barTime5m 放行），无独立的「回调跟踪器」状态机。
5. lint 层面 `src/` 存量错误（ma7/hooks/anomalies 等）与 `scripts/` 存量错误在 main 分支即存在，本次未处理（不属本任务范围，未新增任何 lint 错误）。

**后续建议**
1. 让 pa-action-v1 在启用状态下跑 3-7 天，用「第七节最终目标」的六个问题做数据复盘（PA 对 UTE 的过滤率、回调识别率、入场位置改善、结构止损合理性、扣费后期望）。
2. 回调等待队列可升级为独立状态机（记录首次回调证据，PA 识别多头重新接管时优先重分析）。
3. `trend-trade` 控制台的「算法下拉」里 pa-action-v1 显示为防御性 stub，建议在 UI 上标注「由 /pa-analysis 管理」以避免误选困惑。
4. 若需 PA 15m 背景降本，可加「15m 背景缓存 1h」或改用程序化 15m 结构评估（EMA/HH-LL）做粗筛、AI 背景仅在临界态调用。
