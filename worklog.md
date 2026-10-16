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
