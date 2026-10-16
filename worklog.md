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
