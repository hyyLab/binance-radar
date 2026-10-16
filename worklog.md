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
