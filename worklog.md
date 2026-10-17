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

---
Task ID: 55-4
Agent: main
Task: 60 条历史交易归因分析（用户反馈大部分平仓即亏损，要求总结亏损/盈利规律并对照当前开平仓方案，供用户参与优化决策）

Work Log:
- 导出 trend-auto-v1 最近 60 条 CLOSED TrendTradeMeta（时间跨度 04:57–05:34 UTC，37 分钟，即上次 reset 后全部历史），join PaperPosition + 解析 signalAtOpen/exitSignalJson/featuresAtOpen
- 拉取 Binance futures 1m K 线（限速后改为每 symbol 一次全窗口请求，23 symbols）计算逐笔 MFE/MAE（最大浮盈/最大浮亏，占保证金%）、入场前 5 分钟追价、趋势年龄
- 决策时间线取证：TrendAutoDecision 逐笔对比开仓/平仓信号快照，定位「持仓数秒即 ENDED」的机制
- 代码走读：lifecycle.ts 证据 A/B/C + END_CONFIRM_BARS、config.ts 阈值（minMovePct 0.35 / END_IDLE_TOL_MUL 2.5 → 衰减证据线 0.875%）、auto-trader manageExits END_PENDING 即刻离场
- 产出分析脚本 6 个存 scripts/trend-analysis/（query-trades/analyze/mfe/final/evidence/race-check），中间数据 JSON 可复用

Stage Summary:
- 核心数字：60 笔净 -43.98 U（胜率 17%，盈 25.30/亏 -69.28）；手续费 25.73 + 滑点 10.29 = 摩擦 36.02（占净亏 82%），纯价格亏损仅 -7.96；中位持仓 1.0 分钟；0-2 分钟组 47 笔 -41.58，10-20 分钟组 3 笔全胜 +12.67
- 平仓归因：100% TREND_ENDED；45 笔 END_PENDING 第一根证据即离场（DECAY 32 笔 -19.18 / STRUCTURE_ER 10 笔 -10.38 / REVERSE_CANDIDATE 3 笔 -5.25）；14 笔秒级 ENDED（同根 K 线去重被 dataOk/null 交替打败，DECAY_CONFIRMED 可在 2.3 秒内凑满 3 根）
- 「从赚到拿到亏」：28/50 亏损单浮盈曾覆盖摩擦成本；12 笔浮盈曾 ≥10% 保证金，峰值合计 69.88 U，最终实亏 -32.87 U
- 开仓端缺陷：confirmCount 全部 3-5（确认瞬间追入）；ER<0.3 组 20 笔 -33.15；htfAgree=false 占 87% 照开 -37.92；score 55-70 组最差 -22.51；SHORT 37 笔 -35.79 明显差于 LONG
- 结构性疑点（已代码定位待修）：证据 B 阈值 0.875% 与确认阈值 0.35% 缝隙过窄 → 弱趋势出生即带病；END_PENDING 即刻离场绕过了 END_CONFIRM_BARS=3 的防插针设计；stepLifecycle dataOk=false 路径 barTime=null 会产生一次伪 DECAY 证据
- 结论已发用户（chat），等用户选定优化方向后实施；本轮未改任何生产代码

---
Task ID: 56
Agent: main
Task: 趋势机器人亏损修复——P0 状态机 bug / P1 三根收盘K线确认+阈值迟滞 / P2 入场门槛+二次确认+冷却 / P3 统计采集 + A/B/C 历史回放报告（用户 11 节任务书）

Work Log:
- 实施前核对：lifecycle/config/auto-trader/repo/signal/paper/schema/tests 全读——确认 Task 56 主体代码已在上一会话落盘（lifecycle v2 重构含 barTime 顶层守卫/endEvidenceBarTimes 持久化去重/BIRTH_BAR 排除；config END_MOMENTUM_RATIO=0.6 迟滞；auto-trader manageExits v3=周期匹配+END_PENDING 只记 firstEndSignAt 不平仓+反向确认立即平；entryGateCheck=score/ER/5m15m 过滤；managePendings=等待新收盘K线二次确认（TrendPendingEntry 表）+5min 冷却（lastCloseAt）；updateOpenStats=MFE/MAE 逐 tick 增量；repo 14 个扩展列 PRAGMA 幂等补列；engine 单例 v9；schema.prisma 同步）
- 验证补全：bun test 54/54 绿（T1-T28 + lifecycle 12 用例，覆盖任务书 §十 20 条验收：barTime=null 不计数/同bar去重/重启不重复/旧周期不关新仓(T19)/开仓bar不作结束证据(T22)/END_PENDING 不平(T18)/三根独立收盘K线(T23)/恢复重置(T24)/反向确认平旧仓/数据缺失不伪装(T7)/门槛过滤(T25)/中性严格门槛(T26)/等待bar只开一次(T27)/同周期不重复(T6)/冷却(T13)/20%保证金20x(T2)/多仓约束(T11)/费用滑点MFE/MAE强平(T28/T12)/暂停(T9)/手动盘回归(T1)）
- typecheck 修复：tsconfig 加 "types":["bun-types"]（bun:test 声明缺失，错误 81→76 且全为存量 scripts/ 一次性脚本问题）；lifecycle.test.ts 179 行 Record→unknown 二段转换；engine.ts pickLegacyEngine 参数类型补全 v5-v9 全局声明
- lint 干净；next build 成功（/trend-trading + 3 API 在列）；localhost:3000 三 API 200、lastError=null、20 信号评估中（server 未重启，引擎 v9 热重载接管）
- 回放（§十）新建 scripts/replay/run-replay-t56.ts：A 基线=Task55 线上行为复现（END_PENDING 第一根证据即平+无过滤）/B 仅修 bug/ C=B+score≥70+ER≥0.4+HTF 过滤+二次确认+5min 冷却；12 标的 72h（Bybit/Gate），下一根开盘成交、双边费+滑点、逐仓强平、MFE/MAE 逐分钟增量
- 回放排错 2 轮：①UTE 状态必须跨分钟累积（首次误传 new Map() → 0 笔）；②ER 是本项目 indicators 自算字段，误取 UTE assessment.features.efficiencyRatio（恒 undefined→0）导致 C 全拒——修为 features.efficiencyRatio（线上同源口径）
- 回放结果：A 553 笔净 -81.70 回撤 90.1% 胜率 21.9%；B 684 笔净 -79.06（MFE 1.2→4.8% 但摩擦 158U——仅修 bug 不扭亏）；C 25 笔净 -8.99 回撤 22.8% 胜率 40% MFE 12.7%（LONG +7.68/56% vs SHORT -16.68/31%）；报告 scripts/replay/report-t56.md（含 §十 全部指标：交易频率/盈亏比/摩擦与价格分解/误判率/LONG-SHORT/波动分桶/币种分组）
- 门槛可行性诊断（diag-score-dist.ts + 回放内统计）：9083 个 lifecycle 确认 bar 中 score≥70 仅 967（10.6%，p90=70）→ HTF 拒 369 → 96 待入场 → 25 开仓；ENTRY_MIN_SCORE=70 将使线上交易频率约 0.4 笔/小时（无异动+3 分时更严）——已写入报告警告，未擅自调参
- 无法复现项如实注明：秒级误杀（10s 扫描数据竞态）、旧周期误杀（重启/乱序窗口）在严格时序回放中不可构造，A 的「第一根证据即平」已涵盖主要后果；未编造收益改善（C 仍为负）

Stage Summary:
- 交付：Task 56 全部规格验收通过（54 测试/typecheck 修复/lint/build/线上健康）+ A/B/C 回放报告 report-t56.md
- 核心结论：①仅修状态机 bug 不改变亏损结局（低质量信号摩擦磨损是主因）；②入场过滤把亏损从 -79 收敛到 -9、回撤 90%→23%，但仍为负——不构成盈利能力证明；③SHORT 是主要拖累（与 60 笔归因一致），高周期对 SHORT 的约束是下一轮校准方向；④score≥70 门槛很严（p90=70），调频需回放校准
- 未验证假设：C 的 25 笔为小样本；回放无法复现线上数据竞态类 bug；参数未经多周期稳健性验证
- 遗留：remote 为空且无 token（旧 token 一次性已弃用，不持久化），Task 55-3 的推送远端待用户提供新凭证；线上机器人处于 PAUSED（用户此前设置），余额 66.31 未动

---
Task ID: 56-b
Agent: main
Task: 修复「无法重置/无法恢复交易」——Prisma SQLite 连接永久只读事件（用户报告 reset/resume 按钮全挂）

Work Log:
- 复现：POST /api/trend-trading/control {action:resume/reset} 均返回 1032 attempt to write a readonly database（resume=raw UPDATE、reset=deleteMany，所有写全挂；读正常）
- 排除法定位：磁盘 7.1G 可用、db 目录/文件权限 z:z 可写、lsattr 无不可变位、bun:sqlite 直写 custom.db 成功——文件系统无问题，readonly 只存在于 dev server 进程内的 Prisma 连接
- 根因推断：custom.db mtime 停在 07:02（平台自动快照时间点，git log 同刻有环境快照提交）——快照替换 db 文件 inode 后，进程内 Prisma 引擎旧连接持有失效 inode，写入被 SQLite 判 readonly 且永久不自愈
- 修复（不重启 3000，单例 bump 纪律）：① src/lib/db.ts 单例 v2→v3（新 key 新建 PrismaClient，新 fd 指向现 inode；旧实例不 disconnect 自然淘汰）② engine 单例 v9→v10（autoTrader/trendWatch 持有旧 db 引用必须重建；pickLegacyEngine 链补全 v7/v8/v9 保证 K 线仓库携带不丢失）
- 验证：resume → {"ok":true,"mode":"RUNNING"}（用户 07:02 前设的 PAUSED 已按其「恢复交易」意图恢复 RUNNING）；trendWatch 重建后 dbWrites 25/dbErrors 0（模型层写证实恢复）；池冷启动路径正常（断供超 15min 退池→探针重新积累，45s 后 pool 7/klineReqs 13）；54/54 测试绿、lint 干净、lastError=null
- reset 未在线上实际执行（破坏性：清账户+历史），但其写路径（模型层 deleteMany/update + raw DELETE）与已验证的写同连接同权限——resume（raw 写）+ trendWatch upsert（模型写）双证实后可判定恢复

Stage Summary:
- 交付：只读连接事件修复（db v3 + engine v10），reset/resume 写路径全部恢复
- 机制留痕：平台快照替换 db inode 会令运行中 Prisma 连接永久 readonly（读 OK 写挂）——未来再遇同症状（写报 1032 且文件可直写）直接 bump db 单例即可，无需重启
- 状态：机器人 RUNNING（用户预期），余额 66.31 未动，60 笔历史保留；引擎冷启动重新积累趋势池属预期

---
Task ID: 57
Agent: main
Task: 入场算法重构——通用策略接口（可插拔）+「短周期套利 v1」（用户思路算法化：异动选币不问方向 / 1m 确认定多空+5m 背景分级 / 冲高及时套利 / 走弱先走、同周期走强再入场）+ UI 算法可选框（用户明确：本轮不回测）

Work Log:
- 用户思路逐条映射为算法（strategy/short-swing.ts 头注释逐条留痕）：①选币=异动候选池（策略不读 anomaly.dir 定方向）；②模式 A TREND_ALIGNED=1m 确认+5m 同向→趋势内波段（score≥60/ER≥0.35）；③模式 B RANGE_DIRECTION=5m 震荡/数据不足→1m 先行选向（严门槛 score≥70/ER≥0.45）；④5m 反向拒单（不做逆势，ALLOW_HTF_OPPOSED=false）；⑤WEAKNESS_EARLY=END_PENDING 同周期先走，走强（同周期 CONFIRMED+新收盘 K 线）按轮次再入场（#R2…上限 2，REENTRY_MIN_GAP_MS=60s）；⑥SPIKE_TAKE=浮盈+短窗（90s）顺向运动≥0.6%→及时落袋（对冲冲高回落/下杀拉回；SHORT 对称；基于 observe 标记价样本=当时可用数据，无未来泄漏）
- 通用策略接口（strategy/types.ts）：TrendStrategy=evaluateEntry/evaluateExit/observe/nextRound/onOpen/onClose/exportState/importState/bindPersistence；AutoPaperTrader 只做基础设施（扫描/资金 20% 权益/20x/幂等/二次确认/冷却 5min/强平/MFE-MAE/ENDED 周期匹配/反向确认），策略全权决定方向与门槛；registry.ts 工厂表+未知 id 兜底默认（新增算法=实现接口+注册一行）
- 轮次化：决策/待入场键 `{cycleId}#R{round}`（pending 主键/OPEN/CLOSE 决策 id 全链路）；TrendTradeMeta.entryRound 列；「每 symbol 一条 ACTIVE pending」防重 + CANCELED 重建（资金不足等暂时性取消不烧轮次）；resetAccount 清 TrendStrategyState
- 持久化：TrendAutoConfig.strategyId 列（存量行回填）+ TrendStrategyState 表（策略每 symbol 轮次状态 JSON，onOpen/onClose 即时落库，重启恢复再入场语义）；setStrategyId=持久化+热装配实例（control API 先 closeAllManual 清场，同 setMaxPositions 模式）；tick 策略自愈（DB 配置≠实例→重装配）
- UI：头部「算法」下拉（overview 返回 config.strategyId+strategies 注册表）+ AlertDialog 确认切换（说明新算法+自动平仓后果）；头部文案加当前算法名；hook 类型同步
- 测试：新增 tests/trend-trade/strategy-short-swing.test.ts 13 用例（S1-S9：模式 A/B 门槛、逆势拒、相位拒、冲高套利 LONG/SHORT/负浮盈/幅度不足/持仓过短、WEAKNESS_EARLY 同异周期+可关、轮次全链路、gap、状态导入导出、参数声明）；auto-trader.test.ts 适配——T4/T18/T23/T24 改注入 WEAKNESS_EXIT_EARLY:false 保留 Task 56「END_PENDING 不平仓」验收语义，新增 T4b（默认策略 END_PENDING 提前离场→#R2 再入场全链路：entryRound=2 落库）；T25 门槛 60/0.35、T26 重写（5m 反对拒/INVALID 视同震荡严门槛/中性 70+0.45）、T27 轮次键断言、T21 轮次不烧毁
- 修复过程中发现：①upsertMeta 加列后 VALUES 占位符 30→31（T2 大面积失败根因）；②closePosition 旧 meta 快照覆盖同轮写入的 firstEndSignAt（平仓前重读最新 meta）；③spikePct 采样相位对不齐丢窗（改为相对最新样本固定回看窗）
- 存量 bug 修复（线上触发）：Task 54 raw SQL 建表 firstBarTime/firstSeenAt/entryBarTime/mfeAt/firstEndSignAt 为 INTEGER 声明，毫秒值（~1.79e12）超 int32 → Prisma 绑定报 Conversion failed；新增 migrateIntToBigint 幂等迁移（PRAGMA 检测→重建表整行拷贝→改名→重建索引），线上两表迁移完成、lastError 清零
- 引擎单例 bump v10→v11（行为变更必 bump；pickLegacyEngine 链补 v10）；全量 68/68 测试绿（43 auto-trader + 13 策略 + 12 lifecycle）、eslint 干净、next build 成功
- ⚠️ 环境事件（非本次改动所致）：构建/测试期间平台把环境回滚到 07:02 快照（cf62ac1）——dev server 进程消失、db/custom.db 回滚（trend-auto-v1 余额 66.31→100、60 笔历史/手动盘流水清零；测试全程用独立库 trend-trade-test.db 未触碰生产库）。已重启 dev server（原进程已死，恢复性启动非重启运行中实例）、备份回滚库 db/custom.db.rollback-backup-10170820
- 线上验证：/api/trend-trading 返回 strategyId=short-swing-v1+strategies 列表；setStrategy 同值 no-op；skips 实时出现新策略审计（「1m 看空与 5m 背景（up）相反，短周期套利不做逆势」「评分 56 < 60」）；页面 200 含算法下拉

Stage Summary:
- 交付：策略插件架构（types/registry/short-swing 三件套）+「短周期套利」算法（用户六条思路全落地）+ UI 可选框 + 轮次化再入场 + BIGINT 迁移；68 测试全绿；server 3000 已恢复运行（engine v11，策略运行中）
- 红线遵守：纯模拟未动真实下单；手动盘零改动（账户隔离测试 T1 仍绿）；无固定止盈止损（SPIKE_TAKE 是价格行为离场非比例止盈）；20% 权益保证金+20x+冷却+强平全保留
- 未验证假设（用户明确本轮不回测）：short-swing 全部阈值（60/0.35/70/0.45/0.6%/90s/2 轮）为工程初始参数，未做历史回放校准，不构成胜率声明；冲高检测粒度=SCAN_MS 10s（tick 采样），比 K 线收盘快但受限于扫描节奏；MAX_ROUNDS_PER_CYCLE=2 是防磨损上限非优化值
- 遗留：平台回滚吞掉的 66.31 余额与 60 笔历史无法找回（快照即真值）；如需继续可先 reset 再观察新策略表现；后续新算法只需实现 TrendStrategy+注册

---
Task ID: 57-b
Agent: main
Task: 短周期套利入场门槛下调——趋势起点入场（用户反馈：分数不要调那么高，高分=走势已成熟，起点分数不高）

Work Log:
- 实施前核对：strategy/short-swing.ts（SHORT_SWING 参数区 + evaluateEntry 门槛段）、config.ts、auto-trader.ts 引用关系、engine.ts 单例链、两份测试文件全读；grep 确认 Task 56 的 config ENTRY_MIN_SCORE/ENTRY_HTF_STRICT_* 自 Task 57 策略化后已无任何 src 引用（死参数）
- 门槛下调（唯一生效入口 = 策略 SHORT_SWING）：模式 A ENTRY_MIN_SCORE 60→45（≈候选池入池线 40 上方一档，1m 确认瞬间通常可达）、模式 B NEUTRAL_MIN_SCORE 70→55（仍比 A 严一档，但按「起点可达」定线）；ER 门槛不动（0.35/0.45——防震荡磨损与「入场早」正交，用户只要求降分数）；审计文案「趋势波段门槛」→「趋势起点门槛」；策略头注释补 ⑦ 趋势起点入场哲学（用户原话留痕）+ UI description 同步
- config.ts 清理死门槛常量（ENTRY_MIN_SCORE 70/ENTRY_MIN_ER 0.4/ENTRY_HTF_STRICT_*)，替换为指路注释（唯一调参入口在 SHORT_SWING，在此改不生效）
- 存量 bug 顺手修复（typecheck 暴露 + 代码走读坐实）：closePosition 的 catch 块引用 try 内声明的 meta（Task 57 重读快照重构遗留）→ 非 PaperError 异常时 ReferenceError 而非预期「记录 skip 下轮重试」；改用入参 metaIn。策略测试 S6 pos side 补 as const（存量类型噪音）
- 测试适配：S1b score 55→40、S2 bad 65→50、S9 断言 45/55；T25 score 55→40、T26 CCC 65→50 + 用例名 score≥55；全量 68/68 绿；改动文件 typecheck 干净；eslint 干净；next build 成功
- 引擎单例 bump v11→v12（策略默认值变更=行为变更必 bump；pickLegacyEngine 链补 v11）
- 线上验证（未重启 server，热重载+v12 接管）：skip 流出现「评分 53 < 55」（模式 B 新线，旧代码会显示 <70）证实新门槛生效；趋势池冷启动恢复 20 标的/6 确认/dbErrors 0/dbWrites 91；/trend-trading 页面 200；lastError=null；持仓 reconcile 正常

Stage Summary:
- 交付：趋势起点入场门槛（A 45 / B 55）+ 死参数清理 + closePosition catch 作用域 bug 修复；68 测试全绿，v12 已接管
- 行为预期：交易频率将显著高于 60/70 时代（Task 56 回放显示 score≥70 仅覆盖 10.6% 确认 bar，p90=70）——这正是用户要的实验方向；ER/5m 反向/轮次/冷却/二次确认等守门全部保留，磨损风险由这些非分数护栏兜底
- 未验证假设：45/55 为用户「试一下」方向的工程取值，未经回放校准；若起点单频繁止损，下一档可调 ER 或再加「新周期 N 根内才允许低分」的时间窗条件
- 观察 suggestion：数小时后可对比本轮 entryRound=1 的 score 分布与此前 60+ 区间盈亏差异

---
Task ID: 57-c
Agent: main
Task: 自动开仓参数控制台（用户可自行调参）+《参数说明书》docx（用户反馈入场滞后：如 ERA 等 4 根 K 线）

Work Log:
- 延迟归因：4 根 K 线 = 1m 确认 3 根（TREND_WATCH.confirmObservations=3，平台状态机固定）+ 待入场二次确认 1 根（可关）+ 10s 扫描粒度——控制台把可安全开放的杠杆全部交给用户，确认根数保持固定（全局池语义）
- 参数域设计（console-params.ts 唯一数据源）：13 个 PARAM_DEFS（分组/类型/范围/默认/含义/调大调小效果三合一文案）——策略域 11 项（SHORT_SWING 覆盖，按 strategyId 存 JSON map）+ 基础设施域 2 项（waitBarConfirm 开关列 + cooldownMs 列）；严格校验（写路径 sanitizeRuntimeParams：白名单/类型/范围，非法 400 中文报错）+ 宽松校验（读路径 lenient：脏数据逐键丢弃回退默认，不阻断交易循环）
- 存储：TrendAutoConfig 加 3 列（strategyParamsJson/waitBarConfirm/cooldownMs，PRAGMA 幂等补列 + schema.prisma 同步）；repo.loadConfig 扩展 + updateRuntimeParams 动态白名单 SET
- 热生效：applyStrategy 装配时解析 DB 覆盖传入 createStrategy(id, params)（registry 工厂签名扩展）；setRuntimeParams 持久化后重装配实例（轮次状态从 TrendStrategyState 恢复不丢）；基础设施参数每 tick 重读即时生效；resetRuntimeParams 一键回代码默认
- 直开路径：manageEntries 按 waitBarConfirm 分支——关 = 策略达标当根直接开仓（快 1 根 K 线）；executeOpen 从 managePendings 抽取共享（容量/同币防御/权益20%测算/幂等抢占/开仓/meta/审计全同构，pending 与 direct 行为不分叉）；cooldownOf 统一冷却取值
- API：overview config.params 返回 defs+生效值（overridden=值≠默认）；control 新增 setRuntimeParams/resetRuntimeParams
- UI：trend-trade-view 头部「参数」按钮（带「改」角标）+ params-console.tsx 泛化渲染（分组/输入框/开关/单参数「默认」钮/恢复全部默认/保存并生效；表单仅打开时挂载——草稿不受 5s 轮询重置）；修复空仓文案残留「评分≥70/ER≥0.4」旧值
- 测试：T29 校验拒绝与通过、T30 调参热生效（45→50 后新信号按新门槛评估）、T31 直开路径（当根开仓/无 pending/幂等键同构/重复扫描不开）、T32 cooldownMs=0 平仓后立即可再入、T33 恢复默认；73/73 全绿（首版 T30 因旧 ACTIVE pending 挡路误判，改「先拒后调再放行」流后绿）
- 引擎单例 bump v12→v13；typecheck/lint 干净、next build 成功
- 说明书：docx skill 全链（create 路由 + design-system R1 配方 + common-rules + docx-js-core + toc），R1+DM-1 封面 + 3 节结构（封面/目录罗马码/正文阿拉伯码）+ TOC 占位 22 条 + 页脚格式补丁（ROMAN/arabic）+ 空 pgNumType 清理；内容五章+附录（快速开始/入场链路与 4 根 K 线延迟拆解表/13 参数逐一详解含风险提示/激进保守两套调法对照/安全边界纪律/速查总表），15 页；postcheck 0 错误；LibreOffice 渲染目检封面/目录/正文/附录
- 线上验证（未重启 server）：overview 13 参数返回正常；setRuntimeParams 试改（评分 50+关二次确认）→ 生效值与自定义标记正确 → 非法参数 400 报「不能超过 100」→ resetRuntimeParams 回 45/55 基线；agent-browser 实测控制台弹窗渲染（13 参数分组展示正常，截图 download/task57c-params-console-open.png）；lastError=null，持仓与历史正常（ERA/ICNT 的 SPIKE_TAKE/WEAKNESS_EARLY 流水可见）

Stage Summary:
- 交付：参数控制台（13 参数热生效）+《趋势机器人自动开仓参数说明书.docx》（15 页，download/）；73 测试全绿；引擎 v13 运行中
- 入场滞后的可调空间：关二次确认 = 快 1 根（第 4 根→第 3 根内）；确认 3 根为平台固定设计未开放（改它影响全部标的确认语义与趋势面板）；说明书 2.2 节以 ERA 为例逐根拆解
- 未验证假设：激进/保守两组调法为组合示例未经回放校准；直开路径在线上默认关闭（基线未变），效果需用户实盘观察
- 红线遵守：纯模拟；手动盘零改动；恢复全部默认后线上参数回到 57-b 基线（45/55/二次确认开/冷却 5min）

---
Task ID: HOTFIX-1017
Agent: 主 agent
Task: 修复重启后全线 API 500（Module not found: 'universal-trend-engine'）+ Prisma client 回退

Work Log:
- 用户报 bug；curl /api/trend-trading 证实 500，dev.log 定位为 service.ts:19 Module not found: 'universal-trend-engine'
- 排查：今天 10:44 宿主机整机重启（/tmp/boot-timeline.log），初始化流程重建 node_modules（10:44:09），但 file:./vendor/universal-trend-engine 的链接未恢复；vendor 源目录与 bun.lock 记录均完好
- 修复①：bun install 补回 file: 依赖链接（未重启 server，Turbopack 下次编译自动恢复）
- 连带发现②：重启同时把 node_modules/.prisma/client 打回旧快照（10:44:12 写入，缺 TrendWatchSymbol 模型）→ tests/trend-watch/repo.test.ts 类型化访问 client.trendWatchSymbol.deleteMany 报 undefined，3 个测试挂
- 运行时为何没炸：trend-watch repo 全程 $queryRawUnsafe 原生 SQL，不依赖生成 client 的类型化模型（Task 53 埋的防御）；rg 证实 src 无任何 db.trendWatchSymbol 类型化引用
- 修复②：bunx prisma generate 重生成标准 client（补回模型）；globalThis __radarPrisma_v3 单例保护运行中实例不受影响

Stage Summary:
- 全部恢复：5 个关键 API + 2 个页面 200；引擎 RUNNING、心跳正常（trendSignalCount 1→2）、lastError 空；测试 73/73 全绿；server 3000 全程未重启
- 结论：非代码 bug，属「环境整机重启 → node_modules 重建不完整」事故。两处修复均无代码改动、无引擎 bump
- 遗留观察：db/custom.db.rollback-backup-10170050/10170820 为今日 10:17 生成的历史备份，非本次事故产物，暂不清理

---
Task ID: 58
Agent: main
Task: 仓位测算修复——用户反馈「设置持仓 8 仓，只开出 4 仓就没保证金了」

Work Log:
- 根因：每仓保证金 = 权益 × 20% 与 maxPositions 完全解耦（T17 甚至把「解耦」当正确行为断言）——8 × 20% = 160% 权益物理上不可能开满，第 5 仓起必然「保证金+手续费 > 可用余额」跳过
- 核心修复：effectiveMarginRatio(marginRatio, maxPositions) = min(设定比例, MARGIN_SLOT_HEADROOM 0.95 ÷ 持仓数)（config.ts 唯一定义）——≤4 仓行为与原 20% 定版完全一致；5/6/8 仓自动压缩为 19%/15.83%/11.875%，满仓合计 ≈ 95% 权益（5% 留给手续费+浮动缓冲）；唯一消费点 executeOpen ⑧（pending/direct 共用单点生效）
- marginRatio 接入参数控制台为第 14 参数（infra 域「仓位与资金」组，0.01-1）：console-params 双路 sanitize + effectiveRuntimeParams + repo.updateRuntimeParams 白名单 + autoTrader setRuntimeParams/resetRuntimeParams（列 NOT NULL，reset 回 0.2 而非 null）；每 tick 重读即时生效，只影响新仓不动已有持仓
- 文案全量同步：跳过原因/开仓日志（含 min(20%,95%/8仓) 明细）/openDetail.marginBasis/setMaxPositions note（顺带修掉初版 `?? MARGIN_RATIO*100` 运算符优先级 bug，改用上方已 load 的 current）/持仓下拉 tooltip/换仓确认弹窗/空仓文案口径
- GET overview 新增 config.effMarginRatio（当前仓位数下实际单仓比例）；测试 T17 改语义 + 新增 T17b（8 仓 11.87/11.86 + 预算自洽断言）+ T29a 封顶表 + T34（marginRatio 校验/持久化/sizing 生效/恢复默认）；76/76 全绿；改动文件 typecheck/eslint 干净
- 引擎单例 bump v13→v14（补上 v13 缺失的头注释；pickLegacyEngine 链插入 v13 时一度顶掉 v12，自查发现补回）；说明书 v1.1：manual-content.js 14 参数 + 3.14 保证金卡 + 速查表加行 + 封面版本号，gen-params-manual.js 重生成 + patch-manual-footers.py 页脚补丁
- 线上验证（未重启 server）：v14 热接管（startedAt 更新、lastError=null、用户 11 个自定义参数全保留）；setRuntimeParams no-op 写 200 + 非法值 400「不能超过 1」；接管后新开 2 笔（PROM 13.00/NEAR 13.35）均为封顶比例 ≈11.875%（旧代码会因 ~22 > 可用余额跳过）；审计 marginBasis = "equity × min(0.2, 0.95/8)"

Stage Summary:
- 交付：满仓可开的封顶 sizing + marginRatio 控制台第 14 参数 + 说明书 v1.1（download/趋势机器人自动开仓参数说明书.docx）；76 测试全绿；引擎 v14 运行中
- 行为预期：8 仓下每仓 ≈ 11.875% 权益（总名义敞口 ≈ 19 倍权益，8 仓 × 20x），强平敏感度显著高于小仓数配置——用户需知晓这是满仓的代价；存量旧仓（20% 保证金开的）自然轮换后新仓全部按封顶比例
- 边界保留：余额不足仍跳过不变通；MIN_MARGIN 2 USDT 仍生效；marginRatio 调整不平已有仓（换仓位数才平）

---
Task ID: 59
Agent: Super Z (main)
Task: 用户定版「买入卖出手续费都是 0.02%」——趋势自动账户费率改造上线（手动盘不动）

Work Log:
- 实施前核对：费率唯一源头 futures.ts TAKER_FEE=0.05%（MAKER_FEE 0.02% 仅备案），被 paper.ts（引擎结算 open:290/close:426）与 auto-trader.ts（开仓预检 878/882）共用；手动 default 盘与自动盘同类不同账户——直接改常量会违反「手动盘不受影响」红线，故改为实例属性注入
- paper.ts：PaperEngine 构造第二参 public readonly feeRate（默认 TAKER_FEE=0.05%，default 账户行为逐字节不变）；open/close 结算改读 this.feeRate（单点真值）；paperEngineFor(accountName, feeRate?) 第二参注入；单例按纪律 bump——手动盘 paper v8→v9（类源变更、行为不变、无内存状态重建安全）、自动盘 paperAuto v1→v2（v1 缓存实例为旧费率类源，必须重建）
- trend-trade/config.ts：新增 FEE_RATE: 0.0002（买卖双边各 0.02%，仅自动账户，代码常量非控制台项）；MARGIN_SLOT_HEADROOM 注释的手续费估算同步更新（0.95%→0.38%）
- auto-trader.ts：构造 engine 时注入 TREND_TRADE.FEE_RATE；开仓预检费率改读 this.engine.feeRate（与引擎结算同源不脱钩；测试注入引擎默认 TAKER_FEE 口径随引擎走）；删除已无引用的 TAKER_FEE import；头部成本口径注释更新
- enhanced/engine.ts：单例 bump v14→v15（改行为必 bump——运行中 AutoPaperTrader 持有旧引擎引用，须重建才能换新费率引擎）；pickLegacyEngine 链补 v14
- futures.ts：TAKER_FEE 注释改为「默认费率（手动盘/maxOpenableMargin 上限估算用）」，指路 TREND_TRADE.FEE_RATE
- 验证：bun test 76/76 全绿（FakePaperEngine 继承默认费率，测试零改动）；tsc 报错 0 处涉改动文件（4 处均为未触碰文件的历史遗留）；eslint exit 0；线上不重启验证——/api/trend-trading 触发 v15 热替换，service.on=true、lastError=null、lastTickAt 0.3s、trendSignalCount=20、mode=RUNNING、4 持仓（ICNT/SAND/HYPE/AERO）完好、maxPositions=8 保留
- 语义说明：存量持仓已扣的开仓费（0.05%）不追溯，openFee 按仓位记录逐仓准确；其后所有平仓费与新开仓双边费用均按 0.02% 结算

Stage Summary:
- 自动账户 trend-auto-v1 手续费已切至双边各 0.02%（v15 热替换生效，全程未重启 server）；手动模拟盘保持 0.05% Taker 完全不受影响
- 费率真值下沉为 PaperEngine 实例属性（feeRate），预检与结算同源；三次单例 bump（paper v9 / paperAuto v2 / enhanced v15）均按「改行为必 bump」纪律执行
- 手续费暂为代码常量（config.ts FEE_RATE）；如需运行时可调可仿 marginRatio 接入参数控制台（DB 列 + PARAM_DEFS），用户提出即可做

---
Task ID: 60
Agent: Super Z (main)
Task: 用户报「币安U本位一直红，IP 被封了吗」——诊断 + 封禁升级根治（418 retry-after 纪律）

Work Log:
- 实锤诊断：状态接口 binance ok=False/suspended=True、lastError=HTTP 418 @ /fapi/v1/ticker/price；本机直探 fapi 返回 418 {"code":-1003,"msg":"...IP(8.212.10.159) banned until 1792322420917"}、retry-after 84253s ≈ 23.4h（累犯升级封禁，约次日 19:20-19:40 北京时间解封）；Bybit/Gate ok=True 价格 3s 新鲜——多源代供正常，行情/K线/模拟交易全程未受影响
- 根因 A（自身，已修复）：futures-collector 旧纪律 418/429 只挂起 3 分钟（RATE_LIMIT_SUSPEND_MS=180s），币安实际封禁远长于此 → 每 3 分钟再撞墙 → 每次 418 刷新币安累犯计数、封禁时长逐次升级（2min→…→24h）；且 refreshInstruments 失败 60s 重试完全不看挂起状态、封禁期每分钟都在撞；封禁期内偶发成功（币安边缘节点封禁执行不一致，实测 /time 200、/ping 418）会清零挂起 → 立即恢复轮询 → 又 418，循环放大
- 修复（futures-feeds.ts + futures-collector.ts + types.ts + enhanced-view.tsx）：
  ① FuturesFetchError 增加 readonly retryAfterMs——sFetch 对 418/429 读取 retry-after 头（秒）与 body「banned until <epochMs>」（418 专属最准，取两者大者）
  ② SourceState 新增 bannedUntil（硬截止）；applyRateLimitSuspend：挂起时长 = retry-after+60s（缺头兜底 180s，上限 72h），suspendUntil/bannedUntil 双写
  ③ 三个成功路径（价格/24h/instruments）bannedUntil 感知：封禁期内偶发成功不再清挂起，仅到期后首个成功清零恢复
  ④ refreshInstruments 挂起期入口守卫（不出站，改期到 suspendUntil+5s）；catch 里 418/429 同样按 retry-after 长挂起
  ⑤ 构造器交接补 suspendUntil/bannedUntil/lastError——bump 重建不探针（封禁期重建零撞墙）
  ⑥ getSourcesHealth 暴露 bannedUntil；状态条悬停封禁中显示「IP 被服务方限频封禁，HH:MM 自动恢复（期间 Bybit/Gate 代供）」
  ⑦ 采集器单例 bump v3→v4（改行为必 bump）
- 根因 B（外因，不受控）：修复后实测我们应用完全静默（v4 binance klineReqs 60s 恒 0）期间，fapi x-mbx-used-weight-1m 仍阵发 1526/1629/684/1169/1270 等无规律流量（自身探针仅 1/min）——出口 IP 8.212.10.159（阿里云 HK 共享 NAT）上有其他租户流量在打币安；共享 IP 连坐封禁解释了「令牌桶 480/min ≪ 币安 2400/min 限额却反复被封」。解封后若邻居继续滥打，v4 会按新纪律吃一个 418 即挂满新封禁期、不再放大
- 验证：bun test 76/76、eslint 0、tsc 改动文件 0 新增报错（7 处均为 Ma7/PaperAddResponse 历史遗留）；线上 v4 生效（binance suspended=True 封禁至 bannedUntil、Bybit/Gate 代供、/trend-trading 与 / 全 200），未重启 server

Stage Summary:
- 「一直红」= IP 确被币安 418 封禁（累犯升级至 24h），但功能零影响（多源分片设计兑现）；状态条悬停现可直读解封时刻
- 封禁纪律重构完成：币安说的解封时间就是唯一真值——挂满封禁期、封禁期零出站、偶发成功不提前解锁、instruments 同样停手、重建继承封禁状态
- 外因（共享出口 IP 邻居流量）已用数据坐实；建议如解封后仍频繁连坐，考虑独立 EIP

---
Task ID: 61
Agent: Super Z (main)
Task: 通用算法接口文档——让用户看清「算法怎么写、怎么接进趋势自动交易系统」（零代码实施，纯文档）

Work Log:
- 通读现有策略插件体系确认接口真容：strategy/types.ts（TrendStrategy 全 11 成员 + Entry/Exit Verdict + MarketCtx/PositionCtx）、strategy/registry.ts（STRATEGY_FACTORIES/createStrategy 兜底/listStrategies）、strategy/short-swing.ts（生产参考实现）、auto-trader.ts（tick 十步时序/守卫链/executeOpen 资金幂等/manageExits 四级退出/轮次键 {cycleId}#R{round}）、console-params.ts（PARAM_DEFS 白名单 + lenient 装配丢键语义 + 严格校验 400）、repo.ts 三行结构、trend-watch/signal.ts（UnifiedTrendSignal/TrendPhaseV2）与 indicators.ts（VolatilityFeatures/HtfAssessment）、enhanced/engine.ts（单例 v15 装配与 bump 纪律）
- 关键接线事实核实：setStrategy 先 closeAllManual 清场再热装配；策略 evaluateEntry 只在「CONFIRMED_* + dataFresh + 无持仓/待入场 + 容量冷却通过」时被问；meta.mfe/mae/firstEndSignAt/entryBarTime 可被策略离场复用；PARAM_DEFS 键全局命名空间（新策略参数须前缀防撞 + 不注册即装配期静默丢弃）
- 写 docs/strategy-interface.md（805 行，8 章）：总览与职责边界 → 接口逐方法契约 → 数据契约（信号/特征/ctx/裁决/meta 复用）→ 基础设施硬规则（守卫链/二次确认/退出优先级/轮次）→ 完整教学示例 pullback-v1（可编译、PB_ 前缀参数、峰值回撤离场复用 MFE）→ 接入上线四步（实现/注册/控制台参数/bump v15→v16 四处）→ 运行期管理与审计三查 FAQ → 红线 8 条 + 上线自测 checklist
- 机械化一致性校验（scripts/check-doc-identifiers*.sh）：178 个文档 token ↔ 源码全词匹配，关键标识符（evaluateEntry/StrategyEntryVerdict/SPIKE_TAKE/REVERSE_CONFIRMED/waitBarConfirm/firstEndSignAt/__binanceRadarEnhanced_v15 等）doc↔code 零漂移；修正 TrendPhase→TrendPhaseV2 等 3 处
- 按 pdf 技能 Report 线生产可读版：palette.cascade(--intent cold) 钢蓝色系 → ReportLab 正文（NotoSerifSC/SarasaMonoSC 白名单字体 + install_font_fallback + TocDocTemplate/multiBuild 自动目录 + 代码块 Sarasa 行级可跨页 + 表格全 Paragraph 化 repeatRows=1）→ 封面 Template 01（poster_validate + cover_validate 双过，修 hero 嵌套 span 伪重叠）→ pypdf 归一化 A4 合并 24 页
- 质检闭环：code.sanitize/meta.brand/pages.clean(无空白页)/font.check(0 缺字)/toc.check(pass)/pdf_qa——修复页面尺寸不一致（normalize 阈值 2pt→0.1pt）与 Helvetica 潜入（bulletFontName 默认值陷阱）后 FAIL→WARN；残余 12 条 CJK 窄列标点警告（ReportLab CJK 断行器限制，可接受）与封面左锚边距不对称（Template 01 规范设计）

Stage Summary:
- 交付：docs/strategy-interface.md（仓库长期维护）+ download/趋势自动交易-算法接口文档.pdf（24 页可读版）+ 封面 HTML 源码
- 零代码实施：本任务未改任何 src/ 文件、未 bump 引擎单例（文档不改运行时行为），server 3000 全程未动
- 后续按图施工即可：新算法 = 实现 TrendStrategy（照 §5 示例）→ registry 一行 → 可选 PARAM_DEFS → bump v15→v16；用户已可用该文档评审接口设计并决定下一个算法

---
Task ID: 62
Agent: Super Z (main)
Task: 最开始的 Universal Trend Engine 算法化（universal-trend-v1 上架）+ strategy 目录清晰化 + 控制台按算法过滤（用户定版：UTE 先用代码默认参数，控制台暂不配置）

Work Log:
- 血缘核实：vendor/universal-trend-engine = 系统最初的趋势判定内核（五因子评分 0.35/0.25/0.20/0.15/0.05 + candidate→confirmed 连续 3 根状态机），至今仍是唯一趋势信号源（trend-watch 消费产出 UnifiedTrendSignal，signal.ts 纪律「绝不出现第二套方向算法」）→ 算法化形态定为「UTE 信号直通车」决策层：确认即顺势、确认在就拿满、走弱先走，不自建评分
- 新增 strategy/universal-trend.ts（UniversalTrendStrategy，id=universal-trend-v1）：入场 = 仅 CONFIRMED_* 相位 + 轮次/间隔/新收盘 K 线三道防磨损护栏 + ENTRY_MIN_SCORE（默认 0=纯确认制，UTE 原味）；离场 = WEAKNESS_EXIT_EARLY（END_PENDING 同周期走弱先走，默认开；关=纯持有版等基础设施 ENDED/反向/强平）；observe 空实现（tick 采样是 short-swing 的 SPIKE_TAKE 专属，UTE 只信已收盘 K 线证据）；无冲高落袋；状态持久化与 short-swing 同构（states map + bindPersistence 落 TrendStrategyState）
- registry.ts 注册 + 头注释算法清单表（short-swing-v1 / universal-trend-v1 双行）；DEFAULT_STRATEGY_ID 保持 short-swing-v1（线上运行行为不变，切换由用户在 UI 下拉决定）；strategy/README.md 新建（目录说明 + 两算法对比表 + 新增三步指引，指向 docs/strategy-interface.md）
- console-params.ts 参数按算法过滤机制（Task 62 核心）：ParamDef 加 strategyId 归属字段，11 个 short-swing 参数全部挂 short-swing-v1；effectiveRuntimeParams(strategyId, overrides, infra) 只返回「infra 全部 + 归属当前算法」条目（UTE 下 strategy 域为空）；sanitizeRuntimeParams(严格写路径) 跨策略键 400「不属于当前算法」；sanitizeRuntimeParamsLenient(宽松装配) 跨策略键丢弃回默认；返回类型 ShortSwingParams→Record<string, unknown> 更诚实；三处调用点适配（auto-trader applyStrategy / control setRuntimeParams 先查当前 strategyId / overview route 传 strategyIdNow）
- params-console.tsx：strategy 域为空时显示「当前算法「X」使用内置默认参数，暂无控制台可调项」提示条（props 加 strategyName，view 传 currentStrategy?.name）；修复 ParamsForm 解构漏参（TS2304）
- 测试 tests/trend-trade/strategy-universal-trend.test.ts 16 用例（U1-U8 + CP1-4）：纯确认制低分入场/5m 反向照样入场（与 short-swing 的差异断言）/评分门槛可调/轮次上限 2/再入场新 K 线+间隔/走弱先走可关/无冲高落袋/状态往返/参数按算法过滤四路径；fixture 修正两处（verdict 无 lastBarTime→从 signal 取；TrendTradeMetaRow 补齐 exitReason/exitSignalJson/netPnlWithSlip/openDecisionAt/closedAt 必填）；全量 92/92 绿（76 存量+16 新增）
- 引擎单例 bump v15→v16（scripts/bump-engine-v16.py 机械化：读写点 4 处/声明区 v16 新增 v15 保留/pickLegacyEngine 链首插 v15/头注释 v16 条目；python 直读文件绕开 shell 回显噪声）；typecheck 改动文件 0 错误、eslint 0
- 线上验证（未重启 server）：v16 热接管 lastError=null、lastTickAt 正常；strategies 下拉出现 universal-trend-v1「通用趋势引擎」；当前策略 short-swing-v1 下 params=11 strategy+3 infra 与升级前逐项一致（过滤机制不破坏现状）；5 持仓 reconcile 完好、equity 109.6、33 已平仓胜率 54.5%
- docs/strategy-interface.md 同步（scripts/sync-doc-task62.py）：§6.2 补 universal-trend-v1 真实接入案例、§6.3 机制列表追加第 4 条「参数按算法归属过滤」、§6.4 bump 表述 v15→v16
- 过程教训（再次坐实）：shell 回显会随机吞字符/变形（w-[min( 被渲染成 w-in( 、setRuntimeParams 显示成 setRuntimeParams、sed 输出字母抖动）——本任务两次 MultiEdit 假拒绝（第一次部分应用：strategyName props 已落盘但报「No replacement」）+ 一次基于幻觉 old_str 的误判（Dialog 宽度类其实是好的，od 字节级证伪）；对策固化=编辑后 grep 核验 + 关键内容用 python 直读文件做 assert 式替换 + 测试运行结果作为唯一真值

Stage Summary:
- 交付：通用趋势引擎 universal-trend-v1 上架（最开始的 UTE 直通车）+ strategy 目录说明 + 控制台按算法过滤机制 + 接口文档同步；92 测试全绿；引擎 v16 运行中；全程未重启 server
- 用户预期管理：默认算法仍是短周期套利（线上交易行为零变化）；UTE 在 UI 算法下拉可选，切换会先自动平仓清场再热装配（control API 既有语义）；UTE 控制台无参数可调（代码默认=纯确认制+走弱先走+2 轮上限），用户了解两算法区别后如需调参再按 docs §6.3 注册 DEFS（键前缀 UTE_ 不撞名）
- 两算法核心区别（给用户的一句话）：短周期套利=确认+分数/ER 门槛+5m 背景分级+冲高落袋（在 UTE 之上加过滤）；通用趋势引擎=确认就做、确认在就拿、走弱才走（UTE 裸哲学）；同一信号源，决策层不同
- 未验证假设：UTE 默认参数（ENTRY_MIN_SCORE=0 纯确认制）未做历史回放校准，切换后交易频率预计高于短周期套利（无 ER/背景/分数过滤）；轮次上限 2 与 60s 再入场间隔为防磨损护栏非优化值

---
Task ID: 63
Agent: Super Z (main)
Task: 历史交易两处展示改造——「费·滑」列换「算法」列（费用仅停逐行展示，口径全保留）+ 历史明细默认 10 条折叠展开 + 全量推送远端 binance-radar

Work Log:
- 实施前核对：trades API 行数据源自 TrendTradeMeta+PaperPosition，meta 表无 strategyId 独立列；grep 确认 executeOpen 自 Task 57 起把 strategy.id 写进 featuresAtOpen 快照 JSON（auto-trader.ts featuresAtOpen.strategyId）——历史行的算法信息天然已存在，无需改表/迁移
- 算法列数据链（零 schema 变更、零引擎 bump、零重启）：trades route 从 featuresAtOpen JSON 提取 strategyId（快照损坏/缺失兜底 DEFAULT_STRATEGY_ID=short-swing-v1，Task 62 前唯一在线算法，历史事实正确）；registry.listStrategies() 建立 id→中文名映射（与 UI 算法下拉同源）；行新增 strategyId/strategyName；hook 类型 TrendTradeRow 同步（可选字段）
- UI：TradeHeader「费·滑」→「算法」；TradeRow 费用格 → 算法名格（truncate + title 注明费用累计口径见统计卡）；API 保留 openFee/closeFee/slippageEst 字段（详情链还原与统计仍用）；顶部「累计手续费」统计卡保留（用户仅要求历史列替换）
- 折叠：TrendTradeView 新增 historyExpanded 状态；列表默认 slice(0,10)，>10 条时底部按钮「展开更早的 N 条（共 M 条）/收起，仅显示最近 10 条」；筛选/排序/单笔详情/K 线弹窗交互全部不变
- 验证：bun test 92/92 全绿；tsc 改动文件 0 错误；eslint 0；线上不重启热生效——/trend-trading 页面 200，trades API 实测 50 笔已平仓 = 短周期套利 40 + 通用趋势引擎 10（用户已切 UTE 运行，逐笔标注正确区分两算法）
- 推送：GitHub API 先验证用户新提供的 fine-grained token（对 hyyLab/binance-radar 可写）→ remote origin 重挂（环境回滚曾抹掉 Task 52 的配置）→ main 全量推送（含历史 UUID 快照提交与 db 运行时数据，与 Task 52 惯例一致）；token 仅存 .git/config 本地，绝不写入仓库文件/worklog

Stage Summary:
- 交付：历史明细「算法」列（逐笔可辨开仓算法，混合算法历史首次可读）+ 默认 10 条折叠展开；费用信息在 API/详情/统计卡保留完整口径，仅逐行展示停掉
- 关键设计：复用 featuresAtOpen.strategyId 快照（Task 57 起天然存在）实现零 DB 变更零 bump；未来若需按算法筛选/对比统计（如 UTE vs 短周期套利胜率），再把 strategyId 升为 TrendTradeMeta 独立列（PRAGMA 补列既有模式）
- 红线遵守：未动引擎/未动手动盘/未重启 server；92 测试全绿；纯模拟不变
- 推送补记（实际执行）：远端 main 与本地分叉（另一环境推过 Task 55-3 时代历史）——先核实远端文件集合是本地严格子集（comm 双向比对零独有文件），旧远端历史备份为 backup/task55-3-remote 分支后 force-with-lease 覆盖，main 现为 25e71b0；恢复旧远端视角随时可查 backup 分支

---
Task ID: 64
Agent: Super Z (main)
Task: 算法扩充自助指南——一页速成版 docs/strategy-quickstart.md（用户要自行加新算法并把参数注册进控制台，嫌 807 行接口文档太长）

Work Log:
- 实施前核实四件事：① strategy 目录结构与两个参考实现（short-swing 完整版 / universal-trend 最短骨架）② auto-trader 参数装配链 applyStrategy：parseStrategyParamsMap → sanitizeRuntimeParamsLenient → createStrategy(id, params)，控制台键名原样透传给策略构造器 ③ console-params 的 DEF_BY_KEY 按键名建全局索引（后注册覆盖先注册 → 新算法与 short-swing 键名相撞会让短周期套利同名参数被「不属于当前算法」拒绝）④ UI 下拉数据源 = overview 路由 listStrategies() → strategies 字段，注册即出现（但需 bump 单例让运行中 auto-trader 旧实例退役）
- 新建 docs/strategy-quickstart.md（约 90 行一页版）：算法目录树 / 写算法文件（复制 universal-trend.ts、必改 id/name/description 三字段、evaluateEntry/evaluateExit 两个决策方法 + 其余照抄）/ registry 注册一行 / PARAM_DEFS 每参数一条 + 三条铁规则（key 全局唯一带算法前缀、key 必须等于参数常量键否则改了不生效、strategyId 填自己的 id）/ bump v16→v17 四处不重启 server / curl + UI 验证清单 / 参数保存落库链路排障图
- docs/strategy-interface.md 头部加速成版导航；顺手修正时代标注 v15→v16（Task 62 已 bump，engine.ts L571 实证）；strategy/README.md「新增算法三步」节加快成版指路；rg 核验三处文档互相指路均已落盘

Stage Summary:
- 交付：一页速成文档 docs/strategy-quickstart.md——用户可自助完成「新算法文件 → registry 注册 → PARAM_DEFS 注册 → bump 上线」全流程
- 文档化最关键的两个坑：参数键必须带自己算法的前缀（全局索引撞名即坏短周期套利）；控制台 key 必须 = 参数常量的键（原样透传，对不上改了不生效）

---
Task ID: 65
Agent: Super Z (main)
Task: 每仓保证金动态槽位配额——用户定版「单一持仓时开最大仓位」（旧版单仓被静态 marginRatio=0.2 封死只开 20U）

Work Log:
- 实施前核实：effectiveMarginRatio 旧语义 = min(设定值, 95%÷maxPositions)（按目标仓数静态均分，Task 58）；单仓在场时同样被 0.2 封顶——资金利用率过低（用户实测 20U/100U 权益）；auto-trader L883 唯一消费点 + L973 日志 + L1131 marginBasis 审计串
- config.ts：effectiveMarginRatio(marginRatioCap, openCount) = min(cap, 95%÷(当前持仓数+1))——本仓占用第 n+1 槽位，单仓（n=0）即 min(cap, 95%)，并发越多单仓自动越小（47.5%/31.7%/23.75%…）；退化入防 floor+负数/NaN 按 0（绝不放大比例）；MARGIN_RATIO 默认 0.2→0.95（单仓满配）；MARGIN_SLOT_HEADROOM 注释同步（95% 头寸语义不变：预留手续费+浮亏缓冲）
- auto-trader.ts：调用点改传 eq.openCount（原 cfg.maxPositions）；slot 捕获进日志「min(上限,95%/槽位)」与 marginBasis 审计串（openDetail 签名加 slot）；头注释交易规则同步
- repo.ts schema DEFAULT 0.2→0.95（新装一致）；console-params marginRatio 定义文案重写（新语义 + 「要 N 仓并发调 cap ≤ 95%/N」指引）；API fallback（overview/control/reset）自动跟随常量无需另改
- 引擎单例 bump v16→v17（头注释/类型/legacy 链/getEngine/reset 五处；pickLegacyEngine 链补 v16 缺位——Task 62 遗留，v15 时代旧实例经 v16→v17 两跳交接）
- 测试：T29a 重写为动态槽位配额表（单仓满配/槽位递减/上限封顶/退化入防 11 断言）；T17b 重写（cap=0.2 时不再按目标仓数压缩，maxPositions 只限并发不参与 sizing）；T2/T11/T14/T20 显式 seedConfig 钉住 0.2（容量/手动平仓/重置语义测试与默认值解耦）；T34 恢复默认断言改引用常量；92/92 全绿
- 上线（未重启 server）：热重载后 v17 接管（startedAt 新鲜、lastError=null、lastTickAt 正常）；运行库 UPDATE TrendAutoConfig SET marginRatio=0.95（用户运行 maxPositions=1 + universal-trend-v1，空仓后首仓即权益 × 95% 满配）；overview 实测 effMarginRatio=0.475（1 仓在场 → 下一槽位 2 → 47.5%，公式线上自证）

Stage Summary:
- 交付：动态槽位配额 sizing——单一持仓开最大仓（权益 × 95%），并发自动均分剩余配额；「要 N 仓并发」由静态压缩改为用户自调上限（cap ≤ 95%/N）
- 语义变化明示：marginRatio 从「每仓固定比例」变为「每仓占比上限」；0.95 + 20x 下单仓逆行 5% 即近爆仓线（纯模拟环境如实呈现，强平机制兜底）；余额不足时跳过不变通（原红线保持）
- 未验证假设：满配单仓在高波动 1m 行情的强平频率未回放校准；两笔并发（47.5%×2=95%）恰好触顶预算，手续费可能挤掉第二仓（跳过并记录，可接受）

---
Task ID: 66
Agent: Super Z (main)
Task: 两算法复盘定版（用户 2026-10-17 复盘）——短周期套利顺势化 + 通用趋势引擎方向选择确认制与三层离场

Work Log:
- 实施前核对：两策略全文 + strategy/types + signal.ts（trendStartedAt/endEvidenceBars/features.breakout 可用）+ indicators.ts（breakout=收盘价越出近 3 根区间高/低点）+ auto-trader 装配链与 MFE 增量更新（meta.mfe/mfeDrawdown 每 tick 落库，trailing 数据基础现成）+ console-params 校验链 + 测试 fixture；**sqlite3 CLI 不存在改 python sqlite3 查库**：运行库当前 strategyId=short-swing-v1（非 Task 65 时的 UTE）、strategyParamsJson 全 11 参数覆盖（MAX_ROUNDS_PER_CYCLE=2/SPIKE_MOVE_PCT=0.6——改代码默认必须同步 DB，否则被覆盖压过）
- short-swing 顺势化（用户：「顺势而为……应该在某一个方向走强的时候去顺势，而不是在这个方向走强之后的回调去做低吸」）：① MAX_ROUNDS_PER_CYCLE 2→1（R2 再入场本质=回调后入场，Task 65 统计 R2 合计 -5.63U；同周期走弱离场后不再进，新周期照常第一波）② SPIKE_MOVE_PCT 0.6→0.4（复盘 7 笔浮盈卡 0.3~0.6% 区间合计 -14.82U 够不到落袋线被走弱割掉；0.4%=20x 下 8% 保证金收益）③ 新增 ENTRY_CHASE_PCT=1.2（确认瞬间短窗已顺向冲高 ≥1.2% 拒绝——脉冲末端不追，复盘 17 笔入场即逆行的深亏单多为确认时已在脉冲顶的高分单；SHORT 方向对称看跌幅不误伤）④ 新增 ENTRY_FRESH_MS=180_000（确认时刻距今超 3 分钟不入场——只做方向刚走强的第一时间顺势单，容量等待恢复等场景的追高防护；trendStartedAt 缺失防御性放行）
- universal-trend 复盘定版（用户：①「顺着震荡之后的方向选择的方向来做多或者做空，而不是提前对趋势进行预判性做多或者做空」②「已有盈利的情况下多少止盈、多少止损」③「稍微回调一点就止损不合理」）：① 入场方向选择确认制 REQUIRE_DIRECTION_PICK=true：确认之外要求 features.breakout 与方向一致（字面意义的「震荡之后的方向选择」）或 ER ≥ ENTRY_MIN_ER=0.3（突破后 1-2 根单边延续段），两者皆无=震荡区间内噪声确认拒绝（modeTag NO_DIRECTION_PICK）② 硬止损 STOP_LOSS_PCT=1.0%（价格口径）：逆行 ≥1% 即 STOP_LOSS（=20% 保证金 @20x，常态 ATR 0.2~0.4% 的正常回调远够不到，不「稍微回调就触发」；方向选择失败防拖到强平）③ 移动止盈 TRAIL_ARM_PCT=15/TRAIL_GIVEBACK_PCT=8（保证金口径）：浮盈 ≥15% 激活、从峰值回撤 ≥8% 落袋；峰值=max(meta.mfe 上一 tick 落库, 实时浮盈)——当前 tick 创新高立即生效；④ 走弱先走证据门槛 WEAKNESS_MIN_EVIDENCE_BARS=2：END_PENDING 1 根证据可能是单根噪声（旧版第一根就割=「稍微回调一点就止损」的根源），2 根=连续两根独立收盘 K 线持续走弱，仍早于 ENDED 的 3 根确认；WEAKNESS_EXIT_EARLY=false 的纯持有版语义不变（①②仍在）
- config.ts：TrendExitReason 新增 'TRAIL_TAKE'/'STOP_LOSS'（UI/审计/统计兼容——exitReason 为自由字符串列，旧数据不受影响）；console-params：MAX_ROUNDS/SPIKE 文案更新 + ENTRY_CHASE_PCT/ENTRY_FRESH_MS 注册进控制台（short-swing-v1 归属，第 13/14 个策略参数）；UTE 保持 Task 62 定版不注册控制台（代码默认）；auto-trader 头注释开仓/离场规则段同步；strategy/README.md 对比表 Task 66 版（含追高防护/止盈/止损/走弱/再入场五行）
- 引擎单例 bump v17→v18 五处（头注释条目/globalThis 类型声明/pickLegacyEngine 签名+链首插 v17/getEnhancedEngine/resetEnhancedEngine）——python assert 式替换（第一次 pickLegacyEngine old 笔误「??(」多括号 assert 挂整脚本未写盘，修正后重跑全过）
- 过程中坐实并绕过两处环境级字符漂移（与 Task 62 同源）：Edit 回显的中文字符与参数名后缀存在不可见变形——对策=①关键逻辑改动用 python assert 式替换 ②以 tsc 类型错误当字节级裁判（参数键名若漂移必报 TS2339，本次零误报证明键名全部字节级一致）③rg/grep 只信匹配成功这个事实不信显示内容
- 测试适配与新增（100/100 全绿，原 92→100）：short-swing fixture trendStartedAt 改 Date.now()-15s（老 barClock 会被新新鲜窗全量挡掉）+ S7 注入 MAX_ROUNDS=2 保机制测试 + S7c 默认 1 轮不再进 + S10/S10b 追入保护（含 SHORT 对称不误伤）+ S11 新鲜窗 + S9 快照更新；UTE fixture 加 breakout 参数 + U2 补突破证据 + U4b 快照 9 断言 + U6 改「1 根不走/2 根走」+ U6b mark 99→99.5（**新硬止损 1.0% 恰好与测试 mark=99 同线——U6/U6b 三处失败根因，mark 99.5 隔离走弱维度**）+ UE1 方向选择五场景（突破同向/ER 延续/双无拒绝/突破反向拒绝/可关回旧版）+ UE2 硬止损三断言（LONG/未达线/SHORT 对称）+ UE3 移动止盈四断言（回撤超限落袋/未达线继续拿/未激活不触发/实时创新高）；auto-trader fixture trendStartedAt 新鲜化 + T4b 注入 MAX_ROUNDS=2 保 R2 全链路 + 新增 T4c 默认 1 轮不再建待入场；CP2 计数 11→13（顺手修掉 python 替换引入的 effect 重复键 TS1117）
- DB 同步：strategyParamsJson 的 short-swing-v1 组 MAX_ROUNDS_PER_CYCLE 2→1、SPIKE_MOVE_PCT 0.6→0.4（python sqlite3 读写回验）
- 线上验证（未重启 server）：curl /api/trend-trading 触发热重载 → v18 接管（service.startedAt 刷新、lastError=null、lastTickAt 10s 内）；控制台 4 关键参数=新默认（ENTRY_CHASE_PCT=1.2/ENTRY_FRESH_MS=180000/MAX_ROUNDS_PER_CYCLE=1/SPIKE_MOVE_PCT=0.4）；最近决策键全部 #R1（QUSDT/NMRUSDT/CAKEUSDT 的 OPEN/CLOSE 为同一轮配对记录非 R2）——顺势定版线上运行中；NMRUSDT 开仓 score=45 恰好命中 45 门槛线（质量门槛生效实证）

Stage Summary:
- 交付：short-swing-v1 顺势化四改动（R2 关闭/落袋线 0.4/追入保护/新鲜窗）+ universal-trend-v1 复盘定版（方向选择确认制 + 硬止损 1% + 移动止盈 15/8 + 走弱证据 2 根）；100/100 测试全绿；v18 运行中
- 语义变化明示：短周期套利同周期只做第一波（走弱离场=周期终点，不再有回调后再进）；通用趋势引擎从「无止盈无止损纯走弱」变三层离场（新增 TRAIL_TAKE/STOP_LOSS 两种平仓原因，历史表可区分）；两算法的入场都收敛到「方向刚走强/刚选向」的第一时间顺势
- 边界保留：基础设施 ENDED 周期匹配/反向确认/强平/冷却/二次确认全部不动；UTE 轮次上限 2 保留（走强回确认仍可 R2——用户批评的 R2 是短周期的回调再进场模式）；short-swing 未加硬止损（用户复盘未提，走弱/ENDED/强平兜底）
- 未验证假设：全部阈值为复盘定版的工程初值未经回放校准（TRAIL 15/8、STOP 1.0%、CHASE 1.2%、FRESH 3min、方向选择 ER 0.3）；方向选择确认制对入场频率的压缩幅度待实盘观察；满配单仓 + 短周期无硬止损的强平风险与前版相同（QUSDT 单 MAE -84% 为旧版行为代价样本）

---
Task ID: 67
Agent: Super Z (main)
Task: 仓位划分按配置舱位数——用户复盘「选两舱但 1 仓占 95 成保证金」判定 Task 65 动态槽位不对，针对每种持仓情况做不同仓位划分

Work Log:
- 根因定位：Task 65 的 effectiveMarginRatio(cap, openCount) = min(cap, 95%÷(当前持仓数+1))——除数是开仓瞬间的实际持仓数而非配置舱位数，首仓（openCount=0）永远吃满 95%，第二仓开时余额只剩 ~5%。DB 实锤：SUSDT 首仓 margin=95.0（权益 95 成）、后续 BTWUSDT/ICNTUSDT 仅 11.15/11.17，与用户描述完全吻合
- 修复定版：effectiveMarginRatio(cap, maxPositions) = min(cap, 95%÷配置舱位数)——划分只看「选了几舱」：1 舱单仓满配 95%（Task 65 前用户诉求保留），2 舱各 47.5%、3 舱各 31.7%、4 舱各 23.75%、8 舱各 11.875%……每舱配额固定可预期，先开仓不挤占后舱；maxPositions 异常（0/负/NaN）按 1 处理绝不放大
- 涉及面：config.ts（函数重写+MARGIN_RATIO/MARGIN_SLOT_HEADROOM 注释）/ auto-trader.ts（sizing 调用点改传 cfg.maxPositions、开仓日志 95%/N仓、marginBasis、头注释、applyConfig/setRuntimeParams 注释与日志）/ console-params.ts marginRatio desc+effect / control 路由切舱位 note / overview 路由注释 / UI tooltip 两处——control 与 overview 路由本就传 maxPositions，旧语义下展示值与文案自相矛盾（展示 95%÷(N+1)、文案写 95%÷N），新语义下自动对齐，零代码改动即修复
- 单例 bump v18→v19 六处（头注释条目/globalThis 声明/pickLegacyEngine 签名/链首补插 v18/getEnhancedEngine/resetEnhancedEngine）——链首补插修复 Task 66 后链头只到 v17 的隐患（不补则热重载后旧 v18 实例漏停双实例并存）
- 测试重写：T17b 变用户场景回归（marginRatio=0.95 默认 + maxPositions=2 → 两仓各 ≈47.5，首仓 <48、总保证金 ∈(94,95) 满舱预算兑现）+ T29a 配额表换 (cap, maxPositions) 口径（含 0/负/2.7/NaN 防御）+ T2/T17/T34 注释同步（fixture cap 0.1/0.2 低于任何舱位线，断言值全不变）；100/100 全绿
- 环境坑第三次实锤且升级：①T2 行中文字面量 Edit 匹配失败（不可见漂移）→ python 行号定位+ASCII 子串断言脚本完成剩余替换（scripts/task67_test_update.py，自底向上防位移）②MultiEdit 报「No replacement was performed」但前序编辑已落盘——原子性失效，报错后必须 grep 复核实际状态再决定补丁范围（本次 9 个编辑实际落了 4 个）
- 线上验证（未重启 server）：热重载后 overview 返回 effMarginRatio=0.11875=95%÷8——旧函数在此场景必输出 95%÷9≈0.1056，新函数输出为决定性证据；v19 实例接管（startedAt 刷新、lastTick 3.3s 内、lastError=null）；存量 2 笔持仓不追溯，新开仓按舱位配额
- tsc：ma7-ui.ts/collector.ts/aggregate.ts 3 个报错经 git stash 对照确认 HEAD 状态同样存在（存量，与本次无关）；本次 8 文件零新增类型错误

Stage Summary:
- 仓位划分语义定版：配额 = min(marginRatio 上限, 95%÷配置舱位数)，选 N 舱则每舱 95%/N、选 1 舱满配——「单仓开最大」与「多舱均分」两诉求同时成立，配额在开仓前即可预期（控制台切舱位 note 直接展示新配额）
- 每舱配额固定后不再有「先到先得挤占」：Task 65 的滚动开大仓模式废弃，代价是仓位未满时资金利用率低于满配（选 2 舱只来 1 个信号时闲置 47.5%）——用户以「划分可预期」优先定版
- v19 运行中；改动文件 8 个 + 测试更新脚本 1 个；Task 65 的 DB marginRatio=0.95 存量值在新语义下无需迁移

---
Task ID: 68
Agent: Super Z (main)
Task: 两算法二轮定版——通用趋势引擎长周期化（用户「持仓时间太短，它是长周期的模型」）+ 短周期套利再入场解禁（用户「没强制只做第一顺势单，只是它胜率更高」）

Work Log:
- 线上实据校准：DB 历史已被重置，现存 3 笔 UTE 平仓全部 2~6.5 分钟离场（WEAKNESS_EARLY -6.84U / STOP_LOSS -2.92U / TRAIL_TAKE +1.05U）——Task 66 三层离场把长周期模型逐层砍成分钟级，与用户反馈完全吻合；strategyParamsJson={}（用户已恢复默认）→ 改代码默认即生效值，零 DB 同步
- universal-trend.ts 长周期三处定版：① WEAKNESS_EXIT_EARLY true→false（END_PENDING 走弱迹象只是「可能」结束的前兆不再离场，持有到基础设施 ENDED/反向确认/强平——「确认在就拿满整个周期」）② 硬止损 1.0→1.5%（1.0% 贴着生命周期容忍回撤带 minMovePct×2.5=0.875%，趋势内正常回撤贴近带上沿就扫掉长仓 =「稍微回调就止损」残留；1.5% 让止损住在趋势模型自身容忍的噪声带外，20x 下 -30% 保证金仍远早于强平）③ 移动止盈 15/8→30/20（15/8=0.75% 冲高激活/0.4% 回吐落袋是分钟级脉冲尺度；30/20=1.5% 价格启动保护/1.0% 回吐落袋 > 容忍带，净锁利下限 10% 保证金）；WEAKNESS_MIN_EVIDENCE_BARS 保留供开关重开
- short-swing.ts 再入场解禁：① MAX_ROUNDS_PER_CYCLE 1→2（第一顺势单按时间顺序天然先做、胜率偏好的自然体现，R2 触发事件=「重新走强」回确认+新收盘 K 线，非回调低吸代名词；追入保护全轮次生效）② ENTRY_FRESH_MS 仅约束首轮 R1（evaluateEntry 重排：⑤ 轮次约束提前→新鲜窗加 nextRound===1 条件；R2 的新鲜度由「重新走强」事件自身定义——否则确认超 3 分钟后 R2 永远进不去，解禁形同虚设）；SPIKE 0.4/CHASE 1.2 保持
- 同步面：console-params 两参数 desc/effect（MAX_ROUNDS 默认 2 新语义 / FRESH 仅首轮）、registry 算法清单表、strategy/README.md 对比表（走弱离场行=不离场/止盈止损/再入场行）、两策略 description（UI 下拉同步）
- 测试 101/101 全绿（原 100+S12 新增）：UTE U4 快照（1.5/30/20/false）+ U6 改注入 true 验证机制保留 + U6b 改默认实例断言长周期 + UE2 数值重算（98.2/98.8/101.8）+ UE3 数值重算（mfe 40/mark 100.9/101.6）；short-swing S7c 反转（默认 2 轮 → #R2 放行）+ S11 改「仅首轮」标题 + 新增 S12（R2 不受确认年龄限制：6 分钟前确认仍放行）+ S9 快照；auto-trader T4b 去 MAX_ROUNDS 注释按默认参数验证 R2 全链路 + T4c 改注入 1 轮验证用尽路径
- 单例 bump v19→v20 六处（头注释/globalThis 声明/pickLegacyEngine 签名/链首插 v20+v19 两跳/get/reset）——链首补插修复 Task 67 后 pickLegacyEngine 链头只到 v18 的隐患（不补则热重载后 v19 旧实例漏停双实例并存）
- 线上验证（未重启 server）：v20 接管（startedAt 刷新、lastError=null、lastTick 7.5s 内）；控制台 MAX_ROUNDS 默认 2 + FRESH「仅约束首轮」文案生效；skips 活证据「确认已走老（7.8 分钟前确认…）首轮只做方向刚走强的第一时间顺势单」（R1 追入实时拦截、文案带「首轮」字样）；HTF 反向拦截照常；账户 92.23 无持仓正常待机
- tsc：改动文件零新增类型错误（git stash 对照 HEAD 同为 25 处存量，全在无关文件）；eslint 改动 8 文件 0 报错

Stage Summary:
- 交付：通用趋势引擎长周期定版（走弱不离场 + 止损 1.5% + 移动止盈 30/20）+ 短周期套利再入场解禁（2 轮 + 新鲜窗仅首轮）；101 测试全绿；v20 运行中
- 两算法定位更清晰：UTE=长周期趋势跟随（拿满周期、利润回吐有底线）；short-swing=短周期脉冲套利（快进快出、第一顺势单优先不排他）
- 语义变化明示：UTE 持仓时间将显著拉长（代价：END_PENDING→ENDED 之间的浮盈回吐更深，由宽移动止盈兜底）；short-swing R2 恢复（代价：同周期磨损面+1 次开仓，有追入保护+新 K 线门槛约束）
- 未验证假设：1.5% 止损与 30/20 移动止盈为长周期工程初值未经回放校准（样本仅 3 笔）；R2 恢复后的胜率表现待实盘观察（Task 65 旧 R2 -5.63U 是「回调低吸」时代数据，新 R2 语义=重新走强）；UTE 无 weakness 离场后 ENDED 前的极端插针由强平线兜底

---
Task ID: deploy-1
Agent: Super Z (main)
Task: 从 GitHub 克隆并部署 binance-radar 项目（hyyLab/binance-radar，私有仓库）

Work Log:
- 用用户提供的 GitHub PAT 定位仓库 hyyLab/binance-radar（私有，TypeScript，main 分支，最新提交 5d13110 Task 68）
- git clone 到临时子目录后整体迁移至部署根目录 /home/z/my-project（替换脚手架），保留仓库 .git 与 db/ 历史数据（custom.db 1.4MB + 2 个 rollback 备份 + trend-debug.db）
- 运行 init-fullstack.sh 初始化环境；确认 Caddyfile 网关 :81 → localhost:3000 路由不变
- bun install 870 包成功（含 file:vendor/universal-trend-engine 本地包）；prisma generate + db push，schema 与存量库完全同步（零数据丢失）
- .env 沿用 DATABASE_URL=file:/home/z/my-project/db/custom.db，与仓库约定一致
- 重启 .zscripts/dev.sh 守护进程（首次启动时项目文件尚未迁移完成导致 app 目录缺失报错，迁移后重启即恢复）
- Agent Browser 端到端验证：/ 首页（币安热点雷达：异动引擎状态栏、P1/P2/冷却/已结束事件池）与 /trend-trading（趋势自动模拟交易：账户 100U、运行中徽标、算法/舱位选择器）均正常渲染；参数控制台弹窗交互正常
- 趋势服务自动拉起：/api/trend-trading 返回 mode=RUNNING、lastError=null（v20 单例正常接管）
- 外部约束记录：沙箱出口 IP 8.212.10.159 被币安临时限流（spot api.binance.com 约 26 分钟后解除；fapi 约 18 小时后解除）——属共享出口 IP 被历史请求打满，非本次部署引起；Bybit/Gate API 连通正常，引擎将自动恢复采集

Stage Summary:
- binance-radar 已在 /home/z/my-project 成功部署并运行（Next.js 16 + Turbopack dev，端口 3000）
- 数据库历史数据完整保留，趋势交易服务 v20 自动运行，两页面浏览器验证零报错
- 唯一待恢复项：币安 IP 限流到期后行情采集自动恢复（无需人工干预）

---
Task ID: deploy-2（Task 70）
Agent: Super Z (main)
Task: 修复「全站无数据 + 页面报错」——币安 418 封禁期白名单降级建池

Work Log:
- 根因定位：沙箱共享出口 IP 被币安 fapi 418 封禁至次日 11:29（exchangeInfo/行情全部 HTTP 418），而品种白名单硬绑币安 exchangeInfo（futures-collector assignShards/rebuildMerged 以 binance.instruments 为本体）→ 白名单空 → 分片/聚合/引擎跟踪全停 → 全站 0 数据；「报错」= 状态栏币安U本位红点悬停可见「HTTP 418 @ fapi/v1/exchangeInfo」+ 封禁提示（设计内降级展示，但数据面没有兜底）
- 修复（futures-collector.ts，bump v4→v5）：新增 applyDegradedWhitelistIfNeeded——币安清单为空（或降级清单超 1h 陈旧）且 Bybit/Gate 清单就绪时，以 Bybit∩Gate 交集临时建池（条目取 Bybit：币安同构命名+tickSize），挂到 binance.instruments 并标记 instrumentsDegraded；调用点 = refreshInstruments('binance') 失败路径 + rebuildMerged 幂等前置；真 exchangeInfo 到货（解封后小时级刷新）自动覆盖回真白名单、降级标记归位，分片保持单次分配纪律不重排
- 配套：SourceState/构造器交接/freshSource 增加 instrumentsDegraded 字段；FuturesSourceHealth（types.ts）暴露可选 instrumentsDegraded；enhanced-view 状态栏悬停追加「品种池降级：Bybit∩Gate 交集代管，币安解封后自动恢复真白名单」+ 币安U本位标签带 * 角标
- 工程坑（Task 67 同款二次实锤）：enhanced-view 中文字面量 Edit/MultiEdit 三连「No replacement was performed」但前序编辑已落盘（原子性失效）→ 改用 python 行号定位 + ASCII 子串锚定替换（scripts/task69_title_patch.py）一次成功
- eslint 改动 3 文件 0 报错；tsc 零新增（存量 ma7/paper 无关报错与 HEAD 一致）
- 线上验证（热重载 v5 接管）：45s 内 tracked 0→76、baselineReady 76/76；2 分钟后 tracked 103、基线 103、活跃事件 5（P2 池 ALT/AVA 实卡）、tierCounts HIGH36/MID63/LOW116、tickers 530、引擎出站 286 req；Bybit 供价 412 / Gate 287 / 币安 home=125 预留；趋势服务 lastError=null、trendSignalCount 4；浏览器悬停提示完整呈现降级说明；审计面板展开正常、console/页面零报错

Stage Summary:
- 币安封禁期数据链路全通：白名单降级（Bybit∩Gate 交集）→ 分片 → 供价（Bybit/Gate）→ K 线（挂起源跳过）→ 引擎基线 → 异动/趋势信号，全站数据恢复
- 解封自愈路径明确：refreshInstruments('binance') 在 bannedUntil 后自动重试 → 真白名单覆盖 → instrumentsDegraded=false，Top125 分片归属已预留、恢复后币安自动回到供价/K 线主力位
- 语义代价明示：降级期品种池 ≈ 445 个（交集）而非币安全量 525+；tickSize/成交额口径按 Bybit/Gate（展示层影响极小，模拟盘规则仍币安语义）；K 线历史为 Bybit/Gate 口径（行情大差不差设计前提内）

---
Task ID: deploy-3（Task 70 收尾 + 数据库恢复）
Agent: Super Z (main)
Task: 提交推送 Task 70 修复；解释状态栏指标（监控/基线就绪/活跃事件）；途中抢救两起数据库事故

Work Log:
- 推送：远端已有用户另一会话的「Task 69: MAJOR P1 breakout strategy」（engine v21）→ 我方修复重编号 Task 70（代码注释/worklog/脚本名同步改，只动自己文件）；rebase origin/main 后推送 c5ee173；数据库恢复补丁 2f60d13；用户 v21 策略代码随 rebase 进入部署环境，趋势服务 strategies 现含 major-p1-breakout-v1 三算法
- 事故一（readonly database）：rebase 的 git checkout 把运行中被写动的 db/custom.db 整文件替换，next-server 持有的旧 inode 变 deleted，SQLite 报 1032 readonly——停服重启即解（写路径恢复后无新错误）
- 事故二（部署期空库，追溯根因）：初装时 `cp -rn` 保留了脚手架空 custom.db（24KB），仓库真实库（1.38MB）从未启用——当日全部「新数据」实为空库上自建的全新账户；真实库从 git blob 5d13110:db/custom.db 完整恢复（trend-auto-v1=92.23U 与 Task 68 台账吻合、default=13.61U、8 笔交易、10 条决策、integrity ok）；当日空库快照留 db/custom.db.deploy1017.bak（已 gitignore）
- 经验沉淀：①git 与活动 SQLite 共库是本环境固有风险——rebase/stash/checkout 前必须停服；②cp -n 静默跳过 + mv 目标目录非空时报错被 2>/dev/null 吞掉，两处叠加造成「看似部署成功实则空库」；③sqlite3.connect 对不存在路径会静默建空库，检查脚本必须先判 os.path.exists

Stage Summary:
- 修复已上链：Task 70（白名单降级）+ 真实业务库恢复；线上跑用户真实数据（92.23U/13.61U）
- 布防：custom.db.deploy1017.bak 留档不入库；当日两起事故均为环境操作层，代码无回归
