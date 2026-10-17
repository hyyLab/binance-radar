---
Task ID: 51-b
Agent: Super Z (main)
Task: 按用户要求 K 线同样按分片分配、不全走币安（承接 Task 51 分片架构）

Work Log:
- 审计 K 线链路残留的币安偏向，修两处：
  ① futures-collector klineSourceOrder 兜底顺序重排——归属源优先后，补位顺序改为「非币安源优先、币安永远末位」（旧逻辑 bybit 失败会先试币安再试 gate）；币安只承接它归属分片的 K 线 + 两所同时不可用时的末位兜底
  ② 引擎冷启动回填按归属源轮流排序（bybit→gate→binance 交替发牌）——旧逻辑按 qv 排序取前 125，恰好全是币安分片，冷启动突发全打币安；现在 Bybit/Gate 先就绪，币安那份被令牌桶二次限速；bootBackfillCap 125→220（=maxTracked 全量覆盖），并加 isSharded 门控（分片未分配完不启动回填，防 shardOf 空置期偏币安）
- 可观测性：SourceState 加 klineReqs 计数（fetchKlinesFrom 每次实际派发时累计），getSourcesHealth 暴露，状态条 tooltip 显示「K 线已承接 N req」——分配效果从此可实测验证
- 单例纪律再执行：futures-collector bump v2→v3（改行为必 bump，否则热重载后旧实例仍用旧 klineSourceOrder）；enhanced engine bump v2→v3（回填排序变更），两者均停表遗留实例 + 状态/K线仓库交接（封禁期重建不丢白名单、不重复回填）；collector 交接链已支持 v2（有分片）→v3 与 v1（无分片，shards 兜底空 Map）两种来源
- 被动验证（45s，未发 reset）：引擎 v3 接管（tracked 191 携带仓库）；klineReqs = Bybit 23 / Gate 1 / 币安 0（封禁挂起中 K 线完全绕行）✓；分片归属维持 143/208/171；供价 0/333/171（币安挂起，Bybit 代供）✓；eslint 全绿
- 预期解封后稳态：币安 K 线仅其 143 归属品种（回填 ~1250 权重一次性 + 轮换 ~34/min），轮换大头在 Bybit/Gate（宽松限额）；币安总出站被令牌桶压在 ≤480/min

Stage Summary:
- K 线分配与行情分片同构：归属源供价 + 归属源 K 线 + 非币安优先兜底 + 令牌桶硬帽，四层把币安锁在其 125 份配额内
- klineReqs 计数器让「分配是否真的均匀」从口头承诺变成可实测数字（状态条悬停可见）
- 单例 bump 纪律（改行为必 bump + 状态交接）第三次实战执行，交接链已覆盖 v1/v2→v3 全路径

---
Task ID: 52
Agent: Super Z (main)
Task: GitHub 推送——新建私有仓库 hyyLab/binance-radar，全量推送 main（worklog 仅保留最新条目）

Work Log:
- 用户更换新 token（fine-grained，账号 hyyLab）后重试验证：GET /user 通过，login=hyyLab；GET /user/repos 确认用户已手动建仓 binance-radar（private=True、size=0 空仓、default_branch=main，与建议一致）
- 推送前 git 检查：main 工作区干净，最新提交 efaa448（环境自动快照，仅 db/custom.db 运行时数据，无代码改动）；da40c7b worklog 已精简至仅保留 Task 51-b 一条；此前已用 git grep 复查无敏感信息（token/密钥/密码）
- remote 添加 origin（URL 临时携带 token）→ git push -u origin main 成功（new branch main → main，上游已跟踪）
- 推送后立即 git remote set-url 清除 URL 中的 token；git config 复查 0 处 token 残留
- 验证：API 确认远程 main 顶端 = efaa448 与本地一致；rev-list 本地 42 = API Link header 远程 42，全量完整；私有仓库 fetch 需认证（token 已从 config 清除，本地 fetch 匿名不可用属预期）
- worklog 追加本条记录（仅追加不覆盖）

Stage Summary:
- 代码已全量推送至 https://github.com/hyyLab/binance-radar（私有，42 commits，main）
- 安全收尾：token 不落地——remote URL 已还原为无凭证形式，.git/config 无 token；两个曾出现在聊天中的 token 均建议用户在 GitHub 后台轮换/吊销
- 后续如需再次 push：因 config 无凭证，直接 git push 会要求认证；届时可用 git-credential 管理（如 gh auth login 或 credential store），避免 token 明文进 config

---
Task ID: 53
Agent: Super Z (main)
Task: universal-trend-engine 集成——趋势跟踪服务（第一阶段：只跟踪展示，无自动交易，不动模拟盘）

Work Log:
- 实施前核对：Radar 侧 engine/aggregate/klines/futures-collector/excluded/schema/enhanced-view 全读；UTE 侧 index/watch-monitor/scanner/engine/state-machine/config 全读。确认市场=币安白名单 USDT-M 合约（多源分片供价）、排除规则 isExcludedBase 内建于 collector、KlineStore 轮换 ~5min 不能作 1m 引擎刷新（按任务要求绕开）
- vendor 接入：clone hyyLab/universal-trend-engine @755d9a6 → bun install + tsc build（typecheck OK，自带测试 7/7 过）→ vendor/universal-trend-engine/（package.json+dist/+README+VENDOR.md 同步说明）；Radar package.json file: 依赖 + bun install；不依赖未构建 GitHub 包，不复制不改写 UTE 算法，只 import 公开 API
- Prisma：新增 TrendWatchSymbol 模型（symbol/market/interval 唯一键 + status/addedAt/lastAnomalyAt/expiresAt + trendStateJson/lastSignalJson/lastPhase/lastDirection/lastScore + lastBarTime/lastKlineAt）；db push 仅建表（模拟盘数据完好），generate
- TrendWatchService（src/lib/market/trend-watch/{config,types,repo,service}.ts）：
  · 候选来源=EnhancedEngine.events() 活跃+衰减期内已结束事件；候选选择分=P1 40/P2 25/P3 10 + MAJOR 20/MINOR 8 + 独立证据×8 + 有效突破15 + 放量倍数×4(封顶20) + 活跃10/ended 线性衰减；入池 ≥40 分
  · 流动性门槛（用户定版）：qv24≥500万正常竞争；100~500万仅 MAJOR+（有效突破或≥3 种独立证据）例外通道
  · 迟滞：在池保留下限 = 入池分 -15（防排名抖动频繁进出）；退池=idle+过期后宽限15min / candidate 过期后再给一个完整 TTL / confirmed 不因事件结束退池（回落 idle 后宽限15min）/ 数据断供15min 任何相位都退
  · 上限 20（confirmed>candidate>分数>入池时间的保留序）；K 线仅对池内标的 1m/60s/并发≤3/inflight 去重；fetchKlinesFor 走 collector 归属分片+令牌桶；行情有效期 10s 门控（无效不发 K 线请求）
  · UTE 调用：candle→WatchOhlcvSeries（qv=计价成交额）→scanAnomalyCandidates（toClosedBars 剔未收盘/非法 bar，绝不用 close 造 high/low）；同根 K 线只计一次确认（UTE lastObservationKey + 服务层 lastBarTime 双保险）；方向由价格序列独立判断，与异动方向冲突时快照标 conflict
  · 持久化：仅入池/新 bar/相位变化/方向变化/退池时写库；boot 时 loadActive 恢复池+确认历史（trendStateJson 含 lastObservationKey，重启后同根去重仍生效）
- 引擎绑定：EnhancedEngine 构造器创建 trendWatch（deps 箭头函数延迟绑定 events/getTickers/fetchKlinesFor+prisma repo）；boot 拉起、stop 停表；单例 bump v3→v4（stopLegacyEngine 链覆盖）；EnhancedStats.trendWatch 摘要（pool/confirmed/candidate/klineReqs/dbErrors）
- API：GET /api/enhanced/trends → {ok,ts,interval,market,pool:TrendWatchRow[],stats}；UI：trend-panel.tsx（相位徽章 观察中/候选趋势/已确认趋势 + 方向箭头 up/down/flat + 评分条 + 确认 n/3 + UTE 依据 + 异动上下文 + 冲突红标 + K线过期/数据缺失黄标 + 点击开 CoinDialog 复用 K 线交互），插在事件池与模拟盘之间；useTrendWatch 5s 轮询
- 测试（bun test 零新依赖，tests/trend-watch/）：service.test.ts 12 用例（候选排序/去重/上限20/过期退池/confirmed 保留/未收盘与非法 bar/行情过期不发请求/同根重复不累计确认/上行下行反转/重复启动幂等/回放指标=确认延迟3bar+请求数核算）+ repo.test.ts 3 用例（独立测试库 beforeAll db push，往返保真/重复 upsert/retire 不复活）——15/15 全绿
- 修复过程中的关键决策：
  ① repo 改 raw SQL（$executeRawUnsafe/$queryRawUnsafe）——dev server 进程缓存 schema 变更前旧 PrismaClient（无新模型属性），raw SQL 对新旧 client 一致可用，不重启 3000 端口解决；实验确认 Prisma 6 SQLite DateTime=毫秒整数存储、$queryRaw 读回自动转 Date
  ② src/lib/db.ts 单例 bump v1→v2（同纪律）；旧实例不 disconnect（老模块图在用）
  ③ service ensureStarted 的 starting promise 完成后清理（stop→重入可安全重启）
  ④ ma7.ts 历史遗留 import（从 ./scanner 导入未导出的 isExcludedBase）改 ./excluded——next build 门槛修复，一行
- 验证：eslint 全绿；next build 成功（standalone chunk 含 UTE 代码）；运行时闭环实测：候选池 7 标的/candidate 4 个（W 76 分、BERA 71 分确认 2/3 等真实推进）/dbWrites 17/dbErrors 0；桌面 1440x900 + 移动 390x844 截图渲染正常

Stage Summary:
- 交付：vendor/universal-trend-engine（@755d9a6 本地构建包）+ trend-watch 四件套 + engine v4 + trends API + TrendPanel UI + 15 个测试
- 请求预算：≤20 标的 × 1req/60s ≈ 20 req/min（多源分片自动承接，Bybit/Gate 为主），不扫全市场
- 参数集中于 trend-watch/config.ts（入池分/迟滞/TTL/宽限/并发/UTE lookbackBars=12/minMovePct=0.35/confirmObservations=3），全部为初始工程参数，未经回放校准
- ⚠️ 未验证假设：趋势评分盈利能力未验证（UTE score 是启发式证据分）；未做数周级历史回放对比假阳/漏检/确认延迟分布；confirmed→idle 的 changedAt 语义依赖 UTE 内部行为；趋势确认≠买卖指令，第一版无自动交易，模拟盘逻辑零改动

---
Task ID: 53-b（回滚恢复）
Agent: main
Task: 网站被平台回滚到 10-13 快照（Task 49 时代），从 GitHub 恢复全部工作并验证

Work Log:
- 核查发现本地 HEAD=155242e（Task 49，34 commits），丢失 Task 50~53 共 10 个提交；运行中 dev server 仍是旧代码
- 备份回滚快照的 db/custom.db → db/custom.db.rollback-backup-10170050（含 10-13 时期 3 个旧模拟持仓）
- 一次性 token URL fetch GitHub；发现远程比预期多一个提交：439aafb（Task 53 UTE 集成已完成并推送）
- git reset --hard 439aafb 恢复全部代码；bun install 装回 vendor/universal-trend-engine（file: 依赖）
- bunx prisma generate 重新生成含 TrendWatchSymbol 的 client；验证 /api/enhanced/trends 200、restoredFromDb:13、趋势池已开始评估（1 个 candidate）；首页 200
- 核实评分实现：UTE 趋势分公式（vendor dist/engine.js）+ 入池候选分（trend-watch/config.ts、service.ts scoreOf）

Stage Summary:
- 工作区恢复至 439aafb（=远程 main），网站功能完整恢复；趋势候选池从 DB 恢复 13 标的
- 模拟盘账户现为 10-16 状态（余额 10.00、无持仓，与推送前一致）；10-13 快照含 3 个旧持仓，已备份可回取
- 未验证假设：无（恢复性操作，未改任何业务代码）

---
Task ID: 54
Agent: main
Task: 高波动虚拟货币趋势识别与自动模拟交易一体化（任务规格书 §一~§八）

Work Log:
- 实施前核对：trend-watch 全部代码、paper.ts（无状态全走 DB，可参数化）、engine.ts（单例 v4）、repo raw SQL 模式、fetchKlinesFor（支持 1m/5m/15m）、futures.ts（强平/费率公式）、页面/测试结构
- 趋势识别层（§二）：新增 indicators.ts（ATR/ATR%、日化实现波动率+历史分位→NORMAL/HIGH/EXTREME、Kaufman ER、影线占比、假突破标记、1m→5m/15m 聚合，15m 需 ≥16 根已收盘 bar 否则 valid=false 不冒充确认）；signal.ts（UnifiedTrendSignal 统一信封：相位/方向/周期 id/评分/强度/特征/HTF/数据新鲜度/异动上下文/冲突）；lifecycle.ts（状态机 v2：OBSERVING/CANDIDATE_*/CONFIRMED_*/END_PENDING/ENDED/DATA_UNAVAILABLE；结束证据 A 反向候选 B 深回撤(minMovePct×2.5 容忍带) C 结构失效(ER/一致性)；连续 3 根不同已收盘 K 线才 ENDED；反向确认立即 ENDED；同根去重；数据断供冻结不伪装结束）
- service v2：KLINE_BARS 60→480（聚合 15m 用，币安权重仍 2）；主动探针通道（每 30s 最多 4 个未入池高成交额标的，ER/一致性/量比/区间扩张达标且未走完才入池，deps.probe 开关）；确认趋势满员保护；快照/持久化扩展 v2 字段
- 持久化（§七）：TrendWatchSymbol 加 4 列（lifecycleStateJson/trendCycleId/lastPhaseV2/endReason，ALTER TABLE 幂等迁移）；新表 TrendAutoConfig/TrendTradeMeta/TrendAutoDecision（raw SQL CREATE IF NOT EXISTS，与 schema.prisma 同步）
- 交易层（§三/§四）：paper.ts 构造参数化 accountName（bump v8，default 路径行为不变）+ paperEngineFor('trend-auto-v1')；AutoPaperTrader（SCAN_MS 10s 独立任务：强平巡检→退出管理→权益峰值→开仓；开仓=CONFIRMED_*+dataFresh+20%权益+20x+max4+周期决策键幂等(INSERT OR IGNORE)+先平后开独立性(确认 bar 晚于上笔平仓)；退出=lifecycle ENDED/反向确认；滑点 2bp 单边估算入净盈亏口径；PAUSED 只停新开仓）；engine.ts 集成（v5，后 v6）
- API/UI（§五）：/api/trend-trading（总览/持仓/统计/审计）、/trades（历史+单笔决策链还原）、/control（start/pause/resume/closeAll/close 语义分离）；/trend-trading 独立页面（总览 12 卡+持仓卡+历史表筛选排序+决策链展开+控制按钮）；trend-panel v2 展示（相位/波动状态/ER/15m/通道/冲突/结束证据）；enhanced-view 导航
- 测试（§七）：tests/trend-trade/auto-trader.test.ts 15 用例（账户隔离/20%20x/未确认不开/反向候选不平/ENDED 离场+口径/幂等含重启/数据过期/暂停含强平/reconcile/max4/强平/先平后开/全平 MANUAL/保证金不足审计）；tests/trend-watch/lifecycle.test.ts 7 用例；bunfig preload 固定测试库顺序；全量 37/37 绿
- 生产构建通过（/trend-trading + 3 API 在列）；agent-browser 桌面+移动截图核验
- 回放（§六）：scripts/replay/fetch-history.ts（仅 Bybit/Gate 拉 3 天×12 标的 1m，不碰币安防 418）+ run-replay.ts（严格时序、下一根开盘成交、双边费+滑点、强平公式；v1 基线/v2/v2h 三策略同源 UTE）；**回放发现生产 bug：lifecycle 状态未写回 map（END_PENDING/ENDED 永不推进）→ 修复 + engine bump v6**，线上验证 END_PENDING 3 例、证据计数推进
- 回放结果（72h）：v1 446 笔净-82.39 假确认 78.9%；v2 493 笔净-82.22 假确认 73.4% 胜率 26.6%；v2h(+15m 方向门控) 291 笔净-49.66 假确认 67.4% 回撤 90.5%→58.7%——两套 1m 参数均亏损（手续费磨损），v2h 为明确校准方向（未验证假设）

Stage Summary:
- 交付：趋势识别 v2（指标/多周期/生命周期/统一信号）+ AutoPaperTrader（独立账户 trend-auto-v1，纯模拟）+ 独立页面/API + 37 测试 + 回放框架与 72h 对比报告（scripts/replay/report.md）
- 红线遵守：全程未声称盈利能力；趋势确认≠买卖指令；强平如实统计；所有阈值为未校准工程参数
- 未验证假设（待回放校准）：END_CONFIRM_BARS=3、END_IDLE_TOL_MUL=2.5、ER/一致性门槛、探针判准、15m 门控（v2h）——均标注在 config.ts
- 数据缺口：回放仅 3 天×12 标的（Bybit/Gate 历史），未覆盖极端行情周与更多山寨；无法复现运行期分片供价差异

---
Task ID: 55
Agent: main
Task: 趋势自动交易页交互增强——机器人充值按钮 + 可选持仓数量（更换自动平仓）+ 持仓卡片点击看 K 线

Work Log:
- 需求澄清：用户先说「可选开仓数量」（已实现 marginRatio 方案），随后更正为「可选持仓数量」——每仓保证金由持仓数量决定平均分配，更换数量时自动平仓原有持仓；已按更正需求重做（移除 setMarginRatio，改为 setMaxPositions）
- 后端：config.ts 增 MAX_POSITIONS_OPTIONS=[1,2,3,4,5,6,8]（MARGIN_RATIO 降级为遗留播种字段）；repo.ts 增 updateMaxPositions；control API 增 deposit（复用 PaperEngine.deposit，余额/totalDeposited 原子递增、ROI 本金同步、与手动盘同规则 10~100万）与 setMaxPositions（白名单校验→closeAllManual 自动平仓→持久化；同值 no-op）
- auto-trader sizing 重写（用户定版）：每仓目标保证金 = 可用余额 ÷ 剩余仓位数 ÷ (1+杠杆×taker)（分子预留开仓手续费，否则最后一仓永远开不出；分母用剩余仓位数使每次开仓天然填满一个槽位）；openDetail 审计改记 positionSlots/marginBasis
- 跨模块图坑：control 路由 catch instanceof PaperError 失效（引擎单例由其它路由图创建，类身份不同）——deposit 错误分支改按消息含「USDT」判校验类错误，curl 验证上下限文案正确返回
- 前端 trend-trade-view：头部增「充值」按钮+弹窗（预设 100/500/1000/5000+自定义）、「持仓 N 仓」下拉（confirm 提示自动平仓后果）、头部文案改「每仓=可用余额÷剩余仓位数」+累计充值展示；PositionCard 整卡可点（平仓/K线按钮 stopPropagation）；接入 CoinDialog(market=futures) 并新增 extraPriceLines/extraMarkers——自动持仓成本线/强平线/开仓时点「开」标记叠加在 K 线上
- 测试：T2/T5 改均分口径（动态 notional），新增 T16 充值（balance/totalDeposited 同步、手动盘隔离、下限拒绝）、T17 持仓数量持久化+均分开仓；全量 bun test 39/39 绿
- 线上验证：页面 200；deposit 非法金额返回具体文案；setMaxPositions 同值 no-op；用户实际操作验证全链路——充值 +5000 到账、持仓数改 8 时旧 4 仓自动平仓（03:52:01 人工平仓流水）、新仓按 余额÷8÷1.01≈1018.74 均分重开；持仓卡片点击弹出 SIREN K 线，成本线/强平线/开标记正确

Stage Summary:
- 交付：机器人充值（独立账户、不动手动盘）、可选持仓数量（1~8 仓，更换即清场均分重开）、持仓卡片点击看 K 线（持仓上下文叠加）
- 行为变更：开仓 sizing 由「权益×20%」改为「可用余额÷剩余仓位数」（用户定版）；更换持仓数量=自动平仓+新口径（被平旧周期因幂等键不会立即重开，新仓只来自新确认周期）
- 未验证假设：均分口径为工程实现（余额基准、预留手续费），未做历史回放对比；持仓数量选项 [1,2,3,4,5,6,8] 为界面约定非校准参数

---
Task ID: 55-2
Agent: main
Task: 趋势自动交易页四项改进——持仓更换/全部平仓改内部弹窗、模型判断有问题自行平仓、重置按钮（资金回 100U）、历史展示开仓+平仓时间

Work Log:
- 内部弹窗：trend-trade-view 持仓数量更换/全部平仓/新增重置全部改用 shadcn AlertDialog（confirm 状态机三分支），操作结果反馈由 window.alert 改 useToast（Toaster 已在 layout 挂载）；重置按钮红色危险样式、弹窗标注不可撤销
- 自动平仓 v2（auto-trader.manageExits 重写，用户定版「模型判断有问题即自行平仓」）：① ENDED 任意周期归属（修复旧规则周期回收/ORPHAN 漏配→残留持仓永远等不到退出只能人工平）；② END_PENDING 同周期立即离场，不再等 END_CONFIRM_BARS=3 根（防插针确认根数保留给池内生命周期展示；结束证据明细留 exitSignalJson）；③ 反向确认放宽任意周期；跨周期中间态（异周期 END_PENDING/OBSERVING/CANDIDATE_*）不误平，由 ①/③ 数根 K 线内自然收敛
- 重置：AutoPaperTrader.resetAccount = closeAllManual（正常平仓释放保证金/记 MANUAL 流水）→ 删该账户 PaperPosition/PaperTrade → 清空 TrendTradeMeta/TrendAutoDecision（仅趋势账户使用，无账户维度）→ balance=initialCapital(100)、totalDeposited=0（ROI 本金=initial+deposited 回 100）、peakEquity 归零（repo 新增 resetPeakEquity——updatePeakEquity 是 WHERE peakEquity< ? 峰值语义，写 0 不生效，测试 T20 抓出）；运行模式/持仓数量保持不变
- 历史交易：TradeRow 增开仓时间列（8 列网格重排：开仓时间/平仓时间/币种/方向/开→平价/费·滑/原因/净盈亏），新增 TradeHeader 表头，fmtStamp（月-日 时:分:秒，title 完整时间+持仓分钟数）；排序下拉「按平仓时间」语义不变
- 引擎单例 bump v7（auto-trader 行为变更必 bump：v6 旧实例在 globalThis 存活会使新退出规则热重载后不生效）；resetEnhancedEngine 同步改 v7
- 测试：T18 END_PENDING 即离场（exitSignalJson 留证据）、T19 残留持仓 ENDED 异周期归属也离场、T20 重置（含充值后重置、positions/trades/meta/decisions 全清、balance=100/totalDeposited=0/peakEquity=0）；全量 42/42 绿；生产构建通过
- 线上验证（agent-browser + curl，保护用户数据未在线上执行 reset/closeAll 确认）：三个弹窗均正常弹出/取消（截图 download/task55-{reset,closeall}-dialog.png、task55-history.png）；deposit 校验/setMaxPositions 同值 no-op 正常；live 证据——END_PENDING 中的 ARIA 持仓在引擎 v7 接管后 10s 内被「趋势结束」自动平仓（04:17:01），历史行双时间列渲染正确

Stage Summary:
- 交付：① 三个操作确认全部页内弹窗化（不再有浏览器原生弹窗）② 机器人自动离场规则强化——END_PENDING 报警即走 + ENDED 周期归属不再设限，用户无需再人工兜底 ③ 重置按钮一键回到 100U 起跑线（清仓清历史清审计，ROI 基准归零）④ 历史交易开仓/平仓双时间列
- 行为变更注意：END_PENDING 即平仓比 Task 54 的 3 根确认更快离场，可能牺牲「结束迹象消失恢复确认」场景的持仓连续性（同周期重开被幂等键阻断）——这是用户明确要求的风险换向，阈值 END_CONFIRM_BARS 仍保留在 lifecycle 供池内展示
- 未验证假设：重置后从零重跑的统计口径（胜率/回撤）未做长期观察；reset 未在线上执行（破坏性），仅测试库 T20 覆盖

---
Task ID: 55-3
Agent: main
Task: 开仓 sizing 修复——资金滚动变化导致每仓金额不一致/最后一笔「余额不足」开不出；历史交易点击币种看 K 线；推送远端

Work Log:
- 根因分析（用户实测反馈 + 8 仓观察）：旧口径「可用余额 ÷ 剩余仓位数」每笔开仓重算目标保证金——已实现盈亏/强平/手续费令余额滚动变化，每仓金额不一致；另发现 setInterval 不等待 async 完成，tick 慢于 10s 时并发轮次按同一份旧余额重复开仓（资金双扣）
- sizing v2（auto-trader.manageEntries，用户定版）：每仓目标保证金 = 账户权益 ÷ 持仓数量（金额由持仓数量唯一决定，权益不变时每仓金额一致）；clamp 保护 = maxOpenableMargin(可用余额, 杠杆)（与 PaperEngine.open 校验同源，margin+fee ≤ 余额），资金被打穿时自动降到可承受最大值——数学上保证永不因「余额不足」跳过；仅 clamp 后 < MIN_MARGIN 才跳过（真没钱）；成功开仓后同步维护 eq.equity（= balance+marginUsed+unrealized 自洽）
- tick 重入锁：ticking 标志 + 60s 僵死兜底，并发轮次直接跳过（防双扣余额）；引擎单例 bump v7→v8（行为变更必 bump，旧实例热重载后不生效）
- 历史交易 K 线（用户需求）：TradeRow 币种列可点击（stopPropagation，不干扰整行决策链详情），kline 状态扩展为 {symbol, row?} 双上下文——持仓卡 = 成本线/强平线/开仓标记；历史行 = 开仓价线+平仓价线（紫色）+「开」箭头/「平」圆点双时点标记；复用同一 CoinDialog(market=futures)
- 文案同步：control route note/注释、头部说明、空持仓提示、换仓确认弹窗全部改为「账户权益 ÷ 持仓数量（余额不足时自动降到可承受最大值）」
- 测试：T2/T17 改权益口径（T17 断言逐笔 equity 递减：49.50/49.26，偏差 <0.5 验证金额一致性）；新增 T21 滚动资金保护（首仓开出后把余额打穿到 5u，新周期第二笔照常开出且 clamp 到 4.95 = 5/1.01 而非跳过「可用余额不足」）；全量 43/43 绿；生产构建通过
- 线上 8 仓实测（用户授权）：初始 4 仓 + 多个确认趋势排队（WLD/SIREN/BR/AGT 因「已达最大持仓数」跳过）；setMaxPositions=8 自动平 4 笔旧仓后，新仓 FIL/ICNT 各 13.64 = equity110.21÷8÷1.01 金额完全一致（偏差 0.0），skips 中「不足」类 0 条（全部为正常的先平后开守卫）；观察后恢复原 4 仓设置

Stage Summary:
- 交付：sizing v2 = 权益÷持仓数量（金额一致、由持仓数量唯一决定）+ 余额 clamp（永不余额不足）+ tick 重入锁；历史交易币种点击看 K 线（开/平仓价线与时点标记）
- 行为变更：每仓保证金语义从「余额÷剩余槽位」改为「权益÷持仓数量」——充值/盈亏后金额随权益联动是预期行为（每仓恒为权益的 1/N）；引擎 v8
- 未验证假设：clamp 场景在极端连续强平下的表现（测试库 T21 覆盖单次打穿）；未做历史回放对比
