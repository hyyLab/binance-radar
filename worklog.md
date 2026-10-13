# 项目工作日志

---
Task ID: 1
Agent: Super Z (main agent)
Task: 开发「币安热点雷达」网站 —— 跟踪币安热门交易币种（24h 涨跌幅、突时异动监控）

Work Log:
- 初始化全栈环境（Next.js 16 + TS + Tailwind 4 + shadcn/ui + Prisma/SQLite）
- 验证币安 API 连通性：api.binance.com 主域名可用，实现 4 域名容灾轮换（含 data-api.binance.vision）
- Prisma schema 定义 AnomalyEvent 模型（含 symbol/type/severity/price/changePct/volumeMultiple 索引），db push 完成
- 核心引擎 src/lib/market/collector.ts（globalThis 单例，HMR 安全）：
  · 每 5s 拉全市场最新价，维护价格滚动窗口（20 分钟 5s 精度 + 更早 1 分钟精度，总量 75 分钟）
  · 每 30s 拉 24hr ticker，差分计算每分钟成交额 → 量比（vs 过去 20 分钟均值）
  · 启动回填 Top120 币种 1m K 线（6 并发），短时涨跌即刻可用
  · 异动检测：1 分钟 ≥1% / 5 分钟 ≥2% 拉升跳水（MAJOR 分级）、量比 ≥6 倍放量、突破/跌破 24h 高低点；同币种同类型 5 分钟冷却去重；事件落 SQLite
- API 路由：/api/market/tickers、/anomalies（DB+内存合并去重）、/stats、/klines（20s 缓存 + 参数校验），全部 force-dynamic + no-store
- 前端：币安风格深色主题（#0b0e11 / 涨 #0ecb81 / 跌 #f6465d / 品牌金 #f0b90b），绿涨红跌
  · 总览条：BTC/ETH/总成交额/涨跌家数条形图/近1h异动数（可点击跳转）
  · 三 Tab：热门币种表格（搜索+排序+价格闪烁动画）、涨跌幅榜（双栏 Top20）、异动监控（类型过滤徽章流）
  · 币种详情弹窗：lightweight-charts v5 蜡烛图+成交量，6 周期切换，时轴 UTC+8
  · TanStack Query 轮询（tickers 4s / anomalies 5s / stats 8s）
- ESLint 通过（修复 3 处：effect 内 setState、Pct 未导入）
- Agent Browser 端到端自验：桌面+移动端截图、K 线弹窗、周期切换、搜索、Tab 切换全部通过，控制台/服务端零错误

Stage Summary:
- 产出：完整可运行的币安行情监控网站（单页 / + 4 个 API）
- 实测：649 个交易对实时监测，异动引擎上线即捕获真实信号（AAVE/AVAX 突破新高、ONDO 放量 10.8 倍、IUP 放量 29.7 倍）
- 关键决策：REST 轮询（4s）替代 WebSocket 直连（网关更稳）；异常事件 SQLite 持久化（服务重启不丢历史）；红涨绿跌遵循币安配色习惯
- 文件结构：src/lib/market/{types,binance,collector}.ts、src/app/api/market/{tickers,anomalies,stats,klines}/route.ts、src/components/market/{shared,stats-bar,hot-table,movers,anomaly-feed,kline-chart,coin-dialog}.tsx、src/hooks/use-market.ts

---
Task ID: 2
Agent: Super Z (main agent)
Task: 新增「机会扫描 · 模拟盘」专题页 —— 均线支撑位多空机会 + 大级别支撑位 + 模拟建仓系统

Work Log:
- Prisma 新增 PaperAccount / PaperPosition / PaperTrade 三模型并 db push（首次运行后重启 dev server 以加载新 Prisma Client）
- src/lib/market/indicators.ts：SMA 计算、analyzeMa（3m/5m/15m 回踩 MA5/10/20 企稳做多 / 反抽受阻做空，趋势背景过滤 + 5 维评分≥3 星输出）、analyzeLevels（4h 分形极值聚类成大级别 S/R 区域）
- src/lib/market/scanner.ts：MarketScanner 单例，Top120 币种每 2 分钟扫均线信号（8 并发 ~10s）、每 5 分钟扫 4h 支撑压力；修复首轮 levels 扫描未立即执行的问题（改为信号扫描完成后链式触发）
- src/lib/market/paper.ts：PaperEngine —— 1000 USDT 初始资金、最高 20x、Taker 0.05% 双边手续费、维持保证金率 0.5% 估算强平价、自动强平检查、同币种同方向去重、余额校验；快照含实时盯市盈亏/ROE/胜率/ROI
- 6 个 API：/api/scanner/signals、/api/scanner/levels、/api/paper/{account,open,close,reset}（zod 风格手动校验 + PaperError 业务错误分类）
- 前端：顶栏双视图导航（行情雷达 / 机会扫描·模拟盘）；信号列表（方向+周期过滤、星级评分、买卖按钮）、大级别支撑/压力双卡片（距离排序 + 做多/做空按钮）、模拟盘面板（5 卡片总览 + 持仓表实时盈亏 + 一键平仓 + 平仓流水 + AlertDialog 重置）、一键交易弹窗（币种推荐、多空切换、杠杆滑块、保证金比例/自定义、开仓前预估名义价值/手续费/强平价）
- 用 key 重挂载模式替代 effect 预填（通过 react-hooks/set-state-in-effect 检查）；lint 零错误
- Agent Browser E2E：专题页渲染 ✓、从信号一键开多 BTC 10x ✓（Toast 确认、余额 948.50→710.19）、一键平仓 ✓（净盈亏 -1.19 U 入流水）、API 风控测试（重复开仓/超额保证金/25x 杠杆均正确拒绝）、移动端响应式 ✓、控制台与服务端零错误

Stage Summary:
- 实测数据：60 个均线信号（3m 33 / 5m 24 / 15m 3）、117 个币种大级别 S/R（XAUT 5 点压力聚类）、模拟盘完整交易闭环
- 关键决策：REST 轮询方案沿用；评分制过滤低质量信号（≥3 星）；同币种同方向单仓限制避免仓位叠加混乱；强平检查挂在账户查询/交易前（3 秒轮询内触发）

---
Task ID: 3
Agent: Super Z (main agent)
Task: K 线成本线标注 + 每日热门池（涨幅/跌幅/成交量榜综合选币）+ 扫描范围扩展

Work Log:
- Prisma 新增 HotPoolEntry（date+symbol 唯一，tags JSON，rank）并 db push；重启 dev server 加载新 Prisma Client
- collector 新增热门池引擎：每日 00:00 (UTC+8) 重建，24h 成交额 Top80(VOL) + 涨幅榜 Top40(UP) + 跌幅榜 Top40(DOWN) + 实时放量 Top20(SURGE，量比≥4)，去重后约 130-180 个；当日每 30 分钟随 24h 滚动窗口轻度刷新；服务重启后量能就绪自动补 SURGE 标签（每分钟重试最多 10 次）；名单 best-effort 持久化 SQLite
- getTickers() 每行携带 hotTags；stats 接口返回 hotPool 摘要（date/total/tags 计数）
- scanner topSymbols 改为热门池优先 + 成交额补足，SCAN_TOP 提至 150 —— 涨跌幅小币种进入 3m/5m/15m 信号与大级别支撑扫描范围
- kline-chart 新增 priceLines prop（lightweight-charts createPriceLine，key 比对避免轮询闪烁）；coin-dialog 自动标注该币种模拟持仓的多/空成本线（绿/红实线 + 杠杆标注）与强平价虚线，底部金色持仓摘要条
- hot-table：币对列入选徽章（额/涨/跌/爆）、「仅看热门池」开关（默认开）、金色热门池构成说明条；行数上限提升
- 修复：coin-dialog 误从 use-market 导入 usePaperAccount 导致整站 500；React Compiler lint 报错（ref 渲染期访问 / memo 依赖不匹配）改为 key 比较模式
- 浏览器验证：热门池说明条 134 个（额80/涨40/跌40/爆3）、徽章显示、ALGO K 线成本线 0.11620 + 持仓摘要、扫描器覆盖 144 且出现 GRAM/MORPHO 等小币信号（DOT 带爆标签）、控制台与服务端零错误

Stage Summary:
- 热门池实测：134 个币种（DOT/ZK 三标签 VOL+UP+SURGE）；扫描范围从纯成交额 Top120 → 热门池优先，信号覆盖面显著扩大
- K 线弹窗现在同时展示：K 线 + 成本线 + 强平线 + 持仓摘要，闭环「扫描 → 开仓 → 图上看持仓」

---
Task ID: 4
Agent: Super Z (main agent)
Task: K 线图记录并标注开仓位置与平仓位置

Work Log:
- 新增 GET /api/paper/trades?symbol=&limit=：按币种查询模拟交易流水（PaperEngine 补公开 getAccountId 方法）
- kline-chart 接入 lightweight-charts v5 标记插件 createSeriesMarkers；ChartTradeMarker（timeMs/position/shape/color/text）由图表二分对齐到事件时刻（或之前最近）的 K 线，+8h 时区偏移与蜡烛一致
- coin-dialog：usePaperTrades 拉取该币种流水 → 构建标记（开多▲绿/开空▼红标开仓价；平多/平空箭头按盈亏绿红着色标净盈亏；强平单独红标）→ 传入图表；底部新增「该币种已记录 N 笔交易 · ▲开仓 ▼平仓」说明条
- 运维：发现重复重启导致双 next dev 进程争抢资源（命令超时），清理后单实例启动恢复；确认 dev.sh 方式启动可跨会话存活
- 验证：trades API 返回 BTC 4 笔（2 开 2 平）；浏览器确认图上「开多 82,794.43 / 开多 82,728.64 / 平多 -1.19 / 平多 -0.50」箭头精确定位；控制台与 lint 零错误

Stage Summary:
- 复盘闭环完成：扫描 → 一键开仓 → K 线看成本线/强平线 → 平仓后图上永久保留开/平仓箭头（含盈亏），SQLite 流水支撑

---
Task ID: 5
Agent: Super Z (main agent)
Task: 交易标记简化为 B/S 样式

Work Log:
- 按用户要求将 K 线交易标记从长文字（开多 xx / 平多 +x.xx）简化为交易所经典 B/S 样式
- 映射：OPEN_LONG 与 CLOSE_SHORT（买入）→ 绿色 ▲ B；OPEN_SHORT、CLOSE_LONG、LIQUIDATE（卖出）→ 红色 ▼ S
- 弹窗说明条同步改为「B = 买入 · S = 卖出」
- 浏览器验证：BTC 4 笔交易显示 2 个绿色 B + 2 个红色 S，零报错；lint 通过

Stage Summary:
- K 线标记极简化：B 买 / S 卖，绿买红卖，视觉干净

---
Task ID: 6
Agent: Super Z (main agent)
Task: 机会扫描范围聚焦涨幅榜 / 跌幅榜 / 异动币种

Work Log:
- collector 新增 getHotPoolEntries()（symbol+标签明细）
- scanner 重构 topSymbols → buildUniverse：24h 涨幅榜 Top40 + 跌幅榜 Top40 + 近 4h 异动币种（内存异动事件 + 热门池 SURGE 放量兜底），每 30s 重建候选池，去掉按成交额铺开的逻辑；ScannerStatus 新增 universe 构成明细（gainers/losers/anomalies）
- UI：状态条改为「聚焦涨幅榜 X · 跌幅榜 Y · 异动 Z（共 N 个）」；信号空态说明同步更新
- 运维：本次重启出现 dev.sh 60s 就绪窗口不够与进程被会话回收的情况；清理双实例后以 dev.sh 方式重启并在同会话完成验证，服务跨会话存活
- 验证：覆盖 81 = 涨幅 40 + 跌幅 40 + 异动 3（去重），信号 60 个且集中在 STRK/CHIP/GRAM/AUDIO/CETUS 等动量小币；lint 与控制台零错误

Stage Summary:
- 扫描哲学从「覆盖面」转向「聚焦度」：只扫机会密集区（涨跌榜 + 异动），信号质量与相关性与用户交易场景对齐

---
Task ID: 7
Agent: Super Z (main agent)
Task: 机会扫描仅保留交易最活跃 Top20 虚拟币并剔除股票代币

Work Log:
- 基于实测数据确认股票代币命名规律：股票代码+B 后缀（CRCLB/MSTRB/SPCXB/SNDKB/SOXLB），另有贵金属 XAUT/PAXG、稳定币 RLUSD 混入
- scanner 重构 topSymbols：24h 成交额 Top20 + isExcludedBase 剔除（STOCK_TICKERS 股票代码表 + B 后缀规则 + 贵金属/稳定币黑名单），动态覆盖未来新上市股票代币；移除涨幅/跌幅/异动 universe 逻辑与相关状态字段
- collector STABLE_BASES 补充 RLUSD（稳定币全站剔除）
- UI 文案：状态条「仅扫描交易最活跃 Top20 虚拟币（已剔除股票/商品代币）」；空态说明同步
- 运维：多轮重启遇 .next 陈旧缓存卡死编译（rm -rf .next 解决）与会话回收问题（改用平台 init-fullstack.sh 官方路径重启，稳定存活）
- 验证：覆盖恰好 20 个，信号涉及 ATOM/BNB/AVAX/UNI/SUI/ENA/STRK/NEAR/WLD/ZEC/RLC/KAIA/MAGIC，股票/商品/稳定币零混入；RLUSD 全站剔除；lint 与控制台零错误

Stage Summary:
- 扫描范围最终形态：最活跃 Top20 纯虚拟币，信号干净聚焦主流币

---
Task ID: 8
Agent: Super Z (main)
Task: 机会扫描范围改回「涨幅榜 + 跌幅榜」，榜单每 10 分钟刷新（新反抽币及时纳入），并把异动监控币种加入扫描；保留股票代币排除

Work Log:
- 重写 src/lib/market/scanner.ts：SCAN_TOP=20 活跃币模式 → 宇宙成员制（Map<symbol, {tags, joinedAt}>）
  - 宇宙 = 24h 涨幅榜 Top40（UP）+ 跌幅榜 Top40（DOWN）+ 近 4h 异动币种（ANOM，多标签可叠加）
  - UNIVERSE_REFRESH_MS=10min 全量重建；两次重建之间 boards 增量比对，新进榜/新异动币种实时并入且不驱逐旧成员（保证信号生命周期完整）
  - anomalySeen 记忆化：collector 异动环形缓冲仅 300 条，按币种记 4h 防高频期遗漏；MAX_UNIVERSE=200 防膨胀
  - 保留股票代币排除（STOCK_TICKERS + B 后缀规则 MSTRB/CRCLB 等）与商品/稳定币排除
- types.ts：ScannerStatusDTO.universe 扩展 total / refreshIntervalMin / lastRefreshAt / nextRefreshAt
- scanner-view.tsx 状态条与 signal-list.tsx 空态文案同步新范围与刷新机制
- bun run lint 零错误；dev server 重启（注：本会话环境后台进程跨工具调用会被清理，改为「单条命令内启动+等待+验证」模式）
- curl 验证 /api/scanner/signals：universe {gainers:40, losers:40, total:80, refreshIntervalMin:10}，signals 60 个
- agent-browser 端到端：切到「机会扫描·模拟盘」视图，状态条显示「覆盖 81 个（涨 40 / 跌 40 / 异动 1）」，异动币种已实时纳入，控制台零错误

Stage Summary:
- 扫描范围回归涨跌幅榜 + 异动币种，榜单 10 分钟全量重建 + 新币秒级并入，直接满足「刚开始反抽的新币及时覆盖」诉求
- 涨跌幅榜/异动币种均过滤代币化股票与商品代币；扫描宇宙元数据（重建周期/上次/下次重建时间）已暴露至 API 供前端展示

---
Task ID: 9
Agent: Super Z (main)
Task: 涨跌幅榜 40+40 改为 涨20+跌20，且涨幅榜只出做多信号、跌幅榜只出做空信号（异动币种双向）；修复网站打不开（dev server 掉线重启）

Work Log:
- scanner.ts：GAINERS_TOP/LOSERS_TOP 40→20；scanSignals worker 内按宇宙来源标签过滤信号方向（UP→仅 LONG_MA_SUPPORT、DOWN→仅 SHORT_MA_RESIST、ANOM→双向；成员暂时查不到时宽松放行防整轮清空）
- scanner-view.tsx / signal-list.tsx 文案更新（Top20 + 方向映射说明）
- bun run lint 零错误
- 修复打不开：上一轮后台进程被环境回收导致 3000 端口无服务；本次用 setsid nohup bash .zscripts/dev.sh 标准方式重启成功，验证进程跨工具调用存活（连续两次 curl 200）
- curl 验证：universe {gainers:20, losers:20→21(增量并入不驱逐), anomalies:4, total:43, refreshIntervalMin:10}；signals 45 个（多 23/空 22），levels 41 个全宇宙覆盖
- agent-browser 截图：跌榜币（0G/SNXXB/SENT/SKL，24h -3%~-9%）全部只出「做空」信号，方向过滤正确；控制台零错误

Stage Summary:
- 扫描宇宙收窄为 涨20+跌20+异动，信号方向顺势映射：强币回踩做多、弱币反抽做空，逻辑更聚焦
- dev server 恢复运行，预览可访问

---
Task ID: 10
Agent: Super Z (main)
Task: 机会扫描页新增「异动监控 · 一键交易」板块：实时异动 + 建议做多/做空方向 + 直接模拟开仓

Work Log:
- 新建 src/components/scanner/anomaly-monitor.tsx：自包含组件（useAnomalies 5s 轮询，取最近 30 条）
  - 建议方向映射：SPIKE_UP→做多（短时急拉动量顺势）、SPIKE_DOWN→做空、BREAKOUT_HIGH→做多（突破新高）、BREAKOUT_LOW→做空（跌破新低）、VOLUME_SURGE 按 changePct 正负（放量上攻做多/放量下杀做空）
  - 每条异动：时间 + TypeBadge(强) + 币种(点开K线弹窗) + 详情/触发价/量比/1分钟额 + 「建议做多/做空 · 理由」徽章 + 双按钮（建议方向实心高亮，反向描边）
- scanner-view.tsx：板块置于信号列表/大级别支撑下方、模拟建仓系统上方，复用 openTrade 与 CoinDialog
- lint 零错误；组件层改动 HMR 生效，server 未重启
- 浏览器端到端验证：板块渲染正常（LTC 突破新高行显示「建议做多 · 破位顺势做多」）；点击异动行「买入做多」→ TradeModal 预填 LTC/USDT + 做多方向 → 确认开仓 → toast「买入做多已成交 LTC/USDT · 10x · 开仓价 64.31」；控制台零错误

Stage Summary:
- 异动监控在扫描页可直接交易，方向建议与一键开仓联动，形成「发现异动→判断方向→立即建仓」闭环

---
Task ID: 11
Agent: Super Z (main)
Task: 一键平仓所有交易对按钮 + 修复 100% 买入无法成交（改为最大可买入量直接拉满）

Work Log:
- paper.ts 新增 closeAll()：逐仓复用 close()（各自事务互不影响），返回 {closed, skipped, totalPnl, 逐仓明细}；行情不可用的仓位安全跳过
- types.ts 新增 PaperCloseAllResponse；新建 POST /api/paper/close-all 路由
- use-scanner.ts 新增 useCloseAllPositions：toast 汇总「共平仓 N 个仓位 · 总净盈亏 ±X USDT」
- paper-panel.tsx 持仓卡片头部新增红色「一键平仓全部」按钮（仅持仓>0 显示 + 仓位计数徽章），AlertDialog 确认弹窗展示仓位数与预估未实现盈亏（未含平仓手续费）
- trade-modal.tsx 修复 100% 问题：根因是 margin=balance 时 margin+手续费>余额 永远被拒；新增 maxMargin = floor(余额/(1+杠杆×0.0005)×100)/100（随杠杆联动），100% 档改名「最大」取 min(余额×p, maxMargin)，校验与提交均按 maxMargin，标签行显示「可用 X · 最大可开 Y」，错误文案提示超限需预留手续费
- bun run lint 零错误；dev server 多次被环境回收，全部采用「单命令内重启+等待就绪+验证」模式

Stage Summary:
- API 实测：close-all 6 仓全平（closed:6 skipped:0，逐仓明细正确，账目自洽 206.15+965.43-28.22=1143.37）
- UI 端到端：一键平仓全部按钮→确认弹窗→toast「共平仓 2 个仓位 · 总净盈亏 -0.23 USDT」→持仓清空资金回笼
- 最大可开实测：余额 1142.98/10x → 前端显示最大可开 1137.29（与理论值一致），以 1137.29 开仓成功后余额剩 0.0082（真·拉满）；超 1 分钱 1137.30 被正确拒绝
- 测试仓已清理，最终 持仓 0 / 可用 1131.61（测试损耗约 11.4 U 模拟手续费）

---
Task ID: 12
Agent: Super Z (main)
Task: 排查「又打不开」+ 尽可能保证持续在线

Work Log:
- 诊断：dev server 进程被沙箱平台回收（page 000）；环境无 cron/at/pm2/supervisord，用户无 sudo，PID1 为 tini
- 三种启动方式实测全部被平台清理：setsid nohup、nohup+disown、以及 keepalive 守护脚本本身
- 编写 .zscripts/keepalive.sh：每 20s 健康检查 localhost:3000，掉线自动 pkill+重启+等待就绪，日志记录 DOWN/RECOVERED
- keepalive 实测自愈有效（两次 DOWN→RECOVERED 各约 6 秒），但守护进程自身也会在工具调用间隙被平台回收，无法实现跨轮次保活
- 结论：后台进程回收是沙箱平台层硬约束，应用侧无法彻底对抗；彻底在线需正式部署到外部托管
- 每轮结束前手动拉起 server 确认 200，保证当轮用户可访问

Stage Summary:
- 网站代码无问题；掉线根因是平台沙箱周期回收后台进程
- keepalive.sh 常驻尽力自愈（存活期间 20s 内恢复）；平台清理守护时需对话侧重新拉起
- 已向用户说明彻底方案：部署到 Vercel/自有服务器等正式托管

---
Task ID: 13
Agent: Super Z (main)
Task: 默认杠杆 20x + 充值按钮（增加总权益）+ 异动做空建议加入 24h 趋势过滤（强多头急杀提示低吸）

Work Log:
- trade-modal.tsx：默认杠杆 10→20x（滑块/预填联动最大可开保证金自动跟随）
- schema.prisma：PaperAccount 新增 totalDeposited 字段（db push 同步）
- paper.ts：新增 deposit(amount)（校验 10~1,000,000，balance 与 totalDeposited 同步增加）；snapshot ROI 本金基数改为 初始资金+累计充值（充值不计入盈利）；reset 时 totalDeposited 归零
- 新增 POST /api/paper/deposit + useDeposit hook（toast 显示到账/累计充值）
- paper-panel.tsx：头部新增金色「+充值」按钮 → Dialog 弹窗（快速 100/500/1000/5000 + 自定义金额）；可用余额卡显示「累计充值 +N」；徽章动态显示本金基数（含充值）
- anomaly-monitor.tsx：suggest() 引入 24h 趋势过滤（useTickers 构建 chg24Map）
  - SPIKE_DOWN 且 24h≥+3% → 做多（保守·低吸）：「急杀疑似插针洗盘，破位前不宜追空」，金色徽章标注
  - VOLUME_SURGE 放量下杀且 24h≥+3% → 同上低吸处理
  - SPIKE_UP 且 24h≤-2% → 做空：「急拉疑似反抽出货，追多需谨慎」（对称保守）
  - BREAKOUT_LOW（跌破 24h 新低，24h 必为负）→ 保持顺势做空
- bun run lint 零错误
- API 实测：充值 1000 → balance/totalDeposited 正确、ROI (2149.51-2000)/2000=7.48% ✓；金额 5 被拒绝 ✓
- 逻辑用例 8/8 通过（强多头急杀低吸/中性急杀做空/弱空头急拉反抽/破位顺趋势等）
- 浏览器截图：默认杠杆 20× ✓、充值按钮+本金徽章「2,000 USDT（含充值）」✓、异动监控新文案生效 ✓

Stage Summary:
- 开仓默认 20x 杠杆；模拟盘支持充值扩仓，ROI 口径正确（本金=初始+充值）
- 异动建议从「纯动量」升级为「动量+趋势」：多头趋势中的急杀提示低吸而非追空，空头趋势中的急拉提示反抽而非追多，破位信号维持顺势

---
Task ID: 37
Agent: Super Z (main)
Task: 平台回滚事故恢复——检测到仓库被回退至 10月11日快照（Task 31 之前），重建 Task 31-36 全部功能

Work Log:
- 事故定位：git 历史被平台检查点改写（HEAD=10-11 19:52 UTC，UUID 命名提交）；对象库全量枚举无 12-13 日提交；.next/dev/trace 仅存 peakPriority 字样（编译缓存压缩不可反提取）；文件系统无备份残留 → 结论：只能依据会话上下文重建
- 受损范围：enhanced 引擎全套（6 模块+2 路由+hook+视图）、futures.ts、paper.ts 合约化、page.tsx 简化、collector/pause 路由、worklog 31-36 条目
- 重建（按会话记录逐文件还原）：excluded.ts / futures.ts / paper.ts（v2 key+加仓合并+精确强平）/ trade-modal+paper-panel+use-scanner（10U/2U 下限/币安费率文案）/ page.tsx（双专题页切换）/ pause 路由 / enhanced types+config+aggregate+engine（逐字还原含 peakPriority+prioValue）/ klines.ts+detectors.ts（按规格重写：TTL 缓存中位数与 24h 范围、冻结基线状态机、PENDING 首进入产出、假突破 90s 观察窗、>25% 异常复核）/ anomalies+logs 路由 / use-enhanced / enhanced-view（冷却池最终版）
- 踩坑两连：① paper.ts 导出 PAPER_MIN_DEPOSIT/MAX_DEPOSIT 未 import → ReferenceError（dev.log 定位）② trade-modal 编辑误删 presetMargin 行 → 运行时 ReferenceError（浏览器 overlay 定位）；均已修复
- 验证：eslint 全绿；paper initialCapital=10、重置后 balance=10；BTC 20x 多 2U 强平 -4.62%（与原验证值吻合）；enhanced 冷启动 104 标的回填 232 req、基线就绪 104/104（100%）、活跃事件即时产生；四池/切换器/明细桌面+移动端截图正常；控制台零应用错误
- 运维：全程未重启 server（pid 1096 保持运行）；引擎为首次访问冷启动（回填并发 2+200ms 间隔，无封禁）

Stage Summary:
- 页面恢复至 Task 36 最终形态：模拟盘（10U 合约规则）| 升级版异动交易（四池含冷却池）
- 教训沉淀：平台快照可能回滚工作区——关键迭代后应立即 commit 并在 worklog 记录完整实现细节（本次依赖会话上下文完成无损重建）

---
Task ID: 38
Agent: Super Z (main)
Task: 三项 UI 迭代——删除均线支撑机会与大级别支撑/压力区块、平仓流水可点开、异动事件池标签标注触发时间

Work Log:
- scanner-view.tsx：移除 SignalList（均线支撑位机会）+ MajorLevels（大级别支撑·做多参考/大级别压力·做空参考）及顶部「机会扫描器」状态条（其数据源 useSignals 随信号区一并失去展示意义）；页签现仅保留 异动监控（一键交易）+ 模拟建仓系统
- 删除孤儿组件文件 signal-list.tsx / major-levels.tsx（仅 scanner-view 引用，grep 确认无其他引用）；use-scanner.ts 的 useSignals/useLevels 保留（导出无害）
- paper-panel.tsx：平仓流水改为折叠卡片——默认收起，标题行常显「条数 + 合计盈亏（红绿着色）+ 点开/收起 + 旋转箭头」；展开后流水每行改为 button，点击行打开对应币 K 线弹窗（onSelectSymbol 已有链路）；空仓文案去掉「大级别支撑」措辞
- enhanced-view.tsx EventChip：第二行右侧新增触发时间 fmtHM(firstAt)（HH:MM），tooltip 同步追加「· 触发 HH:MM」；三池（P1/P2/冷却）标签统一生效
- format.ts 新增 fmtHM()（zh-CN hour12:false hour/minute 2-digit）
- 验证：tsc/eslint 对改动文件零错误（全仓 tsc 历史遗留报错与本次无关）；浏览器实证——模拟盘页签顶部即异动监控、平仓流水「1 合计 -1.76 U 点开」→ 展开行点击打开 SKL K 线弹窗 ✓；升级版页签 BLUR「-1.06% 证×3 01:53 单」、XRP/FET/PUMP 时间均显示 ✓；桌面+移动端截图正常（scripts/task37-enhanced-*.png、scripts/paper-flow-open.png）
- 全程未重启 server（dev 热重载自动生效）

Stage Summary:
- 模拟盘页签精简为「异动监控 + 模拟建仓系统」；平仓流水折叠化（默认收起不占空间，合计盈亏常显，行可点开 K 线）
- 异动事件池全部代币标签右上角常显触发时间（HH:MM），与已结束池时间格式一致

---
Task ID: 39
Agent: Super Z (main)
Task: 事件池标签时间改为「X 分钟前」相对格式（用户澄清 Task 38 的时间标注样式）

Work Log:
- enhanced-view.tsx EventChip：第二行时间从 fmtHM(firstAt)（HH:MM）改为相对时间；tooltip 保留绝对时间「触发于 HH:MM」
- 首版直接用 fmtAgo 输出「29 分钟前」，截图发现窄卡片内与「证×2」一起折行 → format.ts 新增 fmtAgoShort()（无空格紧凑版：刚刚 / 29分前 / 3时前）
- EventChip 第二行整体加 whitespace-nowrap，chg/证/时间/确认四个 span 全部 shrink-0 防压缩折行
- 验证：eslint 零错误；桌面截图 PUMP「9分前 待」、GTC「1分前 双」单行无折行；移动端 390px 同样正常；相对时间随页面 1 秒心跳自动跳动

Stage Summary:
- 事件池三池标签时间样式定稿：「X分前」紧凑相对时间（自动刷新），悬停可见绝对触发时间

---
Task ID: 40
Agent: Super Z (main)
Task: 两项调整——事件标签时间改为纯秒数（去「刚刚」/不显分钟）+ 已结束池只归档 MAJOR·曾达P1 事件

Work Log:
- format.ts fmtAgoShort：改为纯秒数累计输出「{s}秒前」（原 刚刚/X分前/X时前 换挡制删除）；事件最长 30min→最长显示「1800秒前」，tabular-nums 10px 下宽度可控
- enhanced-view.tsx：新增 endedShown = ended.filter(level==='MAJOR' && peakPriority==='P1')，已结束池渲染/计数/desc 全部切换到过滤后列表；desc 改「仅 MAJOR·曾达P1 · 保留最近 N 条」；空态文案「暂无 · 仅归档 MAJOR 且曾进入 P1 紧急池的事件」；服务端 ended 缓冲（400 条）保持全量记录不动，仅前端展示过滤
- 验证：eslint 零错误；桌面截图——P2 池 NEAR 537秒前/TAO 387秒前/W 23秒前，已结束池 21 条全为「大」档（MUB/SKL/W 假突破、NVDAB/SKHYB/SOXLB/KORUB 有效突破等），MINOR「小」档全部过滤；移动端 390px 秒数单行无折行
- 全程未重启 server

Stage Summary:
- 事件池标签时间定稿为纯秒数格式（自动跳动，精确感知新鲜度）
- 已结束池语义收窄为「重要事件归档」：仅 MAJOR 且曾进入 P1 紧急池的事件入库展示，MINOR/普通 P3 结束事件仅引擎内部记录

---
Task ID: 41
Agent: Super Z (main)
Task: 升级版异动交易页签新增「持仓明细」面板（免切页签盯持仓涨跌）

Work Log:
- lib/utils.ts 新增共享 pnlCls()（盈亏红绿着色），paper-panel.tsx 删本地同名函数改 import
- paper-panel.tsx PositionsTable 导出（export）并新增 emptyHint 可选 prop（空态文案按页签语境定制）
- 新建 src/components/enhanced/positions-panel.tsx：Card「持仓明细」——标题行含数量徽标 + 浮动盈亏/总权益/ROI 摘要（红绿着色）+「3 秒刷新 · 与模拟盘同账户」+ 金色「手动开仓」按钮；表体复用 PositionsTable（币对点开 K 线 / 一键平仓 / 强平价 / ROE 全功能）；空态文案「在上方事件池点买入做多/卖出做空，或点右上手动开仓」
- 数据源 usePaperAccount（queryKey ['paper-account'] 3s 轮询，与模拟盘同 key 自动去重共享缓存）；useClosePosition 平仓后 toast + 缓存失效联动
- enhanced-view.tsx：EnhancedView 底部（事件明细之后）挂 PositionsPanel；补 openManual()（此前仅 ScannerView 有，漏定义曾致 Runtime ReferenceError，dev overlay 定位后即修）
- 验证：eslint 零错误；API 开 BTC 20x/2U 测试仓 → 升级页持仓明细实时显示（浮动盈亏 -0.01U/总权益 7.92U/ROI -20.80% 与模拟盘一致）→ 页内点「一键平仓」成功（toast「已平仓 BTC」+ 回空态）；桌面+移动端截图正常；期间冷却池吃进真实降级事件 SKHYB（曾P1 徽标）二次实证 Task 36 链路；测试仓已平掉，账户恢复 0 仓位
- 全程未重启 server

Stage Summary:
- 升级版页签闭环：事件池盯机会 → 事件明细看依据 → 持仓明细管仓位（涨跌 3s 刷新 + 一键平仓 + 手动开仓），不再需要切回模拟盘页签
- PositionsTable 升级为跨页签共享组件（emptyHint 参数化）
