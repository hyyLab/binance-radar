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

---
Task ID: 42
Agent: Super Z (main)
Task: 模拟盘手续费双边口径透明化（买入开仓手续费在流水中可见，平仓盈亏改为双边净额）

Work Log:
- 用户反馈「币安买卖都有手续费，为什么这里没有买入时候的手续费」；核查 paper.ts 确认开仓费一直有收（开仓即从余额扣除 margin+fee，DB 中 OPEN 行 fee 合计 0.59），但两处展示缺口让它"隐形"：①Task 38 流水只显示平仓行，开仓行被过滤；②平仓行 pnl=毛盈亏-平仓费，未扣该仓开仓费，合计比余额变化虚高
- paper.ts close()：netPnl 改为 毛盈亏-平仓费-开仓费（双边净额口径，对齐币安已实现盈亏含佣金）；position.pnl 同步净额；余额结算逻辑不变（开仓费开仓时已扣，不重复）
- paper.ts snapshot()：新增按 positionId 批量取 openFee，平仓行 DTO 附带 openFee 字段；types.ts PaperTradeDTO 增 openFee?；LIQUIDATE 行保持原口径不动
- paper-panel.tsx HistoryList：手续费列改显双边合计「手续费 0.153（含开仓 0.076）」（sm 以下只显合计，tooltip 展开明细）；移动端行列超宽问题修复——外层 overflow-auto + 内层 min-w-[520px] sm:min-w-0（窄屏横向滑动看全列，桌面布局不变）
- trade-modal.tsx：计算区 4→6 格（新增「预估平仓手续费」）；脚注改「开/平仓双边均收 Taker 0.05%」；账户卡徽标同步「开/平双边」；useClosePosition 平仓 toast 注明「已扣开/平双边手续费」
- scripts/migrate-close-pnl-net.ts：一次性迁移 8 条历史平仓行 pnl 回补扣除开仓费（迁移后 10+Σ平仓pnl=balance 严丝合缝：10-2.8377=7.1623）
- 排查 dev 热更新失效：改 API 后响应不变，定位为 paperEngine 全局单例（globalThis.__binanceRadarPaper_v2）跨热更新复用旧类实例——bump key 至 _v3 重建实例（PaperEngine 无内存状态，安全）；这解释了此前"改服务端代码不生效"的现象
- 验证：eslint 全绿；桌面 1440 流水每行显双边手续费、账户卡「费 1.18」=开0.59+平0.59、合计-2.84 与余额对账一致；移动 390 展开流水横向滑动正常；开仓弹窗 6 格布局正常；全程未重启 server

Stage Summary:
- 模拟盘费用模型与币安对齐且全程可对账：开仓扣 margin+开仓费 → 平仓回 margin+毛盈亏-平仓费 → 流水行显示双边合计费用与双边净额盈亏 → 合计盈亏+初始资金=当前余额（已实测零误差）
- 发现并修复 dev 模式全局单例阻断服务端热更新的坑（bump 版本 key 解法），后续改 paperEngine 类方法后需再 bump

---
Task ID: 43
Agent: Super Z (main)
Task: 排查「RSR 11:32 明显异动未监测到」——定位并修复 vol1m 全市场冻结导致的成片漏报

Work Log:
- 复盘 11:32 RSR：拉币安 1m K 线还原——1m +2.21%（超 MAJOR 固定阈值 2.0）、5m +2.81%、量比 15×、qv1m 41.7K；自适应阈值复算（medAbs1m=0.297%）证明阈值当时就是固定值，SPIKE 本应 MAJOR 触发 → 问题在输入端
- 发现 AnomalyEvent 表 0 行（enhanced 引擎纯内存缓冲），DB 无从回查；改用 API 缓冲 + 币安 K 线双源还原
- 根因：collector.refresh24h 每 30s 拉全市场 24hr 差分每分钟成交额，但接受条件 dtMin>=0.7（42s）> 轮询间隔（30s）→ 差分几乎全被丢弃 → vol1m/volAvg20m 长时间冻结为旧值（实测 3.5 分钟 0 更新）→ 引擎在异动瞬间看到的是异动前的低量 → SPIKE（qv1m≥1万）与 VOLUME（qv1m≥5万）双双被门槛拦死；大币冻结值恰好高于门槛仍能靠价格触发，中小币成片漏报，VOLUME 检测器全天瘫痪
- 修复：dtMin 窗口改 >=0.35（18s 下限防抖动，perMin 本就按 dtMin 归一化）；collector 单例 key bump v2
- 踩坑与二次修复：dev 下 Turbopack 每个 API 路由可持有独立模块图，首版「无条件替换式」IIFE 把他图正在服务的实例定时器清掉，造成 tickers 路由数据冻结（updatedAt 卡 12:17:09）——改为「同 key 必复用」收敛式单例（跨图共享同实例，代码更新靠 bump key），touch 全部 17 个 route.ts 强制各图重估收敛，随后 ?reset=1 重挂增强引擎（K 线仓库保留）
- 验证：修复前探针 3.5min vol1m 0 更新；修复后 BTC 6 次/RSR 7 次（平均年龄 14-19s、最大 57s）；实时抓到 RSR 12:34:16 MAJOR·P1（量比 21.3×，qv1m 5.0 万U，正是探针看到 49K 跳动的时刻），VOLUME 检测器全线复活（牛来 30×/SPCXB 51×/U 57×）；UI P1 池正常显示 RSR/牛来；eslint 全绿；全程未重启 server
- 现在回看 11:32 RSR：vol1m 修复后 SPIKE 门槛（qv1m≥1万）可过 → 1m +2.21% 会以 MAJOR 触发；VOLUME 检测器 5 万门槛对 41.7K 仍拦（设计门槛，属 Task 32 阶段二分层校准范畴）

Stage Summary:
- 漏报主因修复：vol1m 差分窗口对齐 30s 轮询节奏，量能输入从「冻结假数据」变为 30s 级实时速率，SPIKE/VOLUME 两检测器的成交额门槛恢复判别力
- 架构认知落档：Turbopack dev 每路由独立模块图 → 模块级单例必须「同 key 必复用」；paperEngine（v3）/collector（v2）均已按此模式，后续改这两个引擎代码需 bump key + touch 相关 route.ts
- 遗留：VOLUME 5 万/分钟门槛对中小币偏严（RSR 类 15× 放量仍被拦）、自适应阈值倍数校准——归入 Task 32 阶段二

---
Task ID: 44
Agent: Super Z (main)
Task: 排查并修复「持仓里面的价格没有变化」——paperEngine 闭包绑定 v1 僵尸 collector

Work Log:
- 复现：/api/paper/account 两次调用 RSR 持仓 markPrice 恒为 0.002044（=entryPrice，upnl=0），而 /api/market/tickers 中 RSR 实时价 0.00217 且 updatedAt 毫秒级新鲜——collector 主实例是活的，唯独 paper 链路冻结
- account 路由加临时探针（Task 42 已验证路由热重载可靠）：同请求内路由直读 collector 为 656 币种/RSR 0.002154/4.5s 新鲜，但 paperEngine.snapshot() 算出的 markPrice 仍是 0.002044 → 引擎读的不是同一个 collector
- 根因：Turbopack 每路由独立模块图 + globalThis 单例跨代引用——paperEngine v3 实例创建于 Task 42（collector 重写之前），其类方法闭包绑定了当时模块图导出的 v1 collector；Task 43 修复时执行「v1 遗留停表」清掉 v1 定时器 → v3 引擎从此读僵尸实例（数据停在停表时刻 0.002044）。scanner/enhanced 引擎实测价格与 live 一致，仅 paper 中招
- 修复两层：①collector.ts 新增稳定别名 __binanceRadarCollectorActive（单例解析的每个分支都刷新该别名，v2 复用与新建均指活跃实例）；②paper.ts markPrice() 改为调用时经 globalThis 别名动态解析 activeCollector()（别名缺失才回退模块绑定），并 bump paper key v3→v4 重建实例摆脱僵尸闭包；注释落档跨引擎引用规则
- 验证：修复后 markPrice 0.002123→0.002125 实时跳动、upnl +7.64→+7.84、与 tickers 接口价一致；用户 RSR 多单真实浮盈 +8.42U/ROE +85.1% 得以显示（此前被冻结隐藏）；用户随后 04:53:56 手动平仓于实时价 0.002126，净盈亏 +7.7335U，对账 10+7.7224=17.7224 严丝合缝；eslint 全绿；桌面 1440 持仓面板截图两帧差异 bbox 证实持续刷新，移动端 390 空态正确（仓位已平）
- 探针已还原，account 路由回到干净版；全程未重启 server

Stage Summary:
- 持仓价格冻结根因修复：paperEngine markPrice 经 __binanceRadarCollectorActive 调用时动态解析，collector 未来 bump key 对 paper 透明，不再产生僵尸绑定
- 架构规则落档：globalThis 单例引擎相互引用必须「调用时经稳定别名解析」，绝不能依赖模块图捕获的旧绑定；改 collector 代码 bump key 后无需再连带 bump 消费方引擎

---
Task ID: 45
Agent: Super Z (main)
Task: 对照完整需求规格书逐条核查增强异动引擎；修复 P1 时间语义（「进入P1时刻」起算）与 4 处文档违规

Work Log:
- 通读 enhanced 全部代码（config/detectors/aggregate/engine/klines/types/enhanced-view），逐条对照规格书十四节核查；检测节奏（SPIKE/BREAKOUT 2s、VOLUME 30s）、固定阈值、24h 滚动基准（完整已收盘 1m K线重算+15s缓存，无基准漂移）、聚合合并/冷却/结束、方向规则（§8.2-8.7 全部落地）、置信度分层、通知格式、有效性检查（±50%/80% 疑似复核 + DATA_ANOMALY）均合规
- 量化「事件不多」：近 27 分钟引擎实际产出 60 个新事件（VOLUME 52/SPIKE 11/BREAKOUT 2），少的是「可见事件」——P1/P2 池常空、已结束池仅 6 条。三个根因：①MAJOR 急拉急跌因「方向不明→confirm=PENDING」被压 P3 不可见（27 分钟 3 个 MAJOR SPIKE 2 个被吞，违反§十「已确认的MAJOR急拉急跌→P1」）；②SPIKE 覆盖缺口——statsOf 对不在K线仓库的币返回 undefined 导致 265 个达标币只测 220 个（违反§三「历史不足退回固定阈值」）；③VOLUME 无方向放量按文档本就 P3 仅记录（合规，属设计）
- 修复 4 处违规 + 时间语义：①priorityOf 放宽——MAJOR SPIKE（方向可不明）/有效突破/MINOR→MAJOR升级/MULTI 均进 P1（mergeInto 提前算 upgraded 传入 rejudge）；②statsOf 放开 store.has 限制——无K线币 medAbs=null 自动退回固定阈值（全市场 265 个达标币全覆盖）；③excluded.ts 补稳定币 base 集合（USDC/FDUSD/TUSD/USDP/DAI/USD1/USDE/USDS/PYUSD/AEUR/EURI/EUR/XUSD/BUSD，§2.1）；④detectVolume 暴露基线状态（NO_STORE/SHORT/INSUFFICIENT），engine.volumeTick 节流记录 BASELINE_INSUFFICIENT 日志（每标的 10min 一条，§五）
- P1 时间语义（用户指出的核心）：types.ts EventDTO 新增 p1At（最近一次进入P1时刻，回落再升级会刷新）；aggregate.rejudge 检测 P1 晋级记 p1At；前端 EventChip 增 timeBase 参数——P1/冷却池传 p1At??firstAt、P2 保持 firstAt；已结束池行首绝对时间改 p1At，tooltip 完整时间线（触发于/进入P1/结束于）
- 检查中新发现的违规：P2 条件 evidence.length>=2 允许同类型证据隔窗重复凑数（OGN MINOR 单类型证×1 进 P2）——违反§九「至少两个不同类型」；P2 改 distinctKinds>=2、VOLUME 升级条件同步改 new Set(prevKinds).size>1
- 验证：scripts/verify-p1-rule.ts 单元断言 11/11 通过（MAJOR SPIKE 方向不明→P1、MINOR 单证据→P3、升级→P1+p1At、p1At 不反复刷新、NEUTRAL MAJOR→P3、同类型重复不凑数→P3、MINOR+异类型→P2）；?reset=1 重挂引擎（K线仓库保留 220/220）；eslint 全绿；截图实证 OGN 事件完整生命周期——P2(64秒前)→升P1(6秒前，金框高亮，p1At 语义)→回落P2(曾P1徽标，130秒前 firstAt 语义)；BASELINE_INSUFFICIENT 标记已在日志出现（币安人生USDT）
- 全程未重启 server

Stage Summary:
- 可见事件恢复文档口径：MAJOR 急拉急跌/有效突破/升级事件全部进 P1 立即推送（方向不明不再吞事件），SPIKE 覆盖扩展至全市场 265 个达标币
- P1/冷却/已结束池时间语义定稿：「进入P1时刻」起算（p1At），P2 池保持首次触发时间，tooltip 保留完整时间线
- P2 门槛收紧为「不同类型第二证据」（§九），同类型重复触发不再凑数
- 规格书阶段二遗留项不变：medQv1m 成交额分层统计量、VOLUME 5万门槛对中小币校准、自适应倍数回放校准
---
Task ID: 46
Agent: Super Z (main)
Task: 排查「冷却池一直没东西」——冷却降级链路缺失（曾P1事件永不降出P1）+ 前端冷却池条件过窄

Work Log:
- 用户反馈冷却池一直为空；先拉引擎实时数据取证：BAT 事件 peak=P1/pri=P2/tend=UNKNOWN（曾达P1已回落方向不明）却挤在 P2 池——前端冷却池条件 priority==='P3' 收不到它；更关键的根因在后端 priorityOf：MAJOR 急拉事件 dto.level==='MAJOR'&&hasSpike 恒成立 → priority 永不回落，即使冲高回落/假突破也一直占 P1 池直到 90s 静默结束，「P3+曾P1」组合几乎不可能出现，冷却池成死路
- 后端修复①（retrace/假突破冷却）：rejudge 提出 retraced=spikeRetraced(ev,snap) 到方向分支外（方向判定与冷却判定共用，同 snap 幂等）；priorityOf 新增 cooled 参数——cooled = peakPriority==='P1' && !boConfirmed && (retraced||boFalse) → 返回 P3；只约束「曾经热过现在凉了」的事件，新发生异动不受影响（MAJOR 急拉急跌发生即 P1 口径不变）；有效突破例外：回落未回区间前突破有效性由 FALSE 链路单独判定，不按回撤冷却
- 后端修复②（动量衰减冷却）：sweep 新增——曾P1 仍挂 P1 的事件静默 ≥AGG.coolDownQuietMs（新增配置 45s，须<quietEndMs 90s）→ 先降 P3 进冷却池（peakPriority/p1At 保持，format 同步 headline）；到 90s 结束线照常结束归档 → 冷却池保有 45~90s 观察期；再触发（新证据 merge→rejudge）热度回归会重新达 P1 并刷新 p1At
- 前端修复③：冷却池条件放宽为 priority!=='P1' && peakPriority==='P1' && tendency==='UNKNOWN'（回落途中 P2/P3 都算冷却，P2 只是过渡档位）；P2 池同步排除冷却事件不重复展示（!cooled.includes 引用比较安全——同源 filter）
- 验证：scripts/verify-cooldown-rule.ts 单元断言 27/27 通过（回落进冷却+headline同步[P3]、创新高回P1+p1At刷新、假突破冷却、未达P1不冷却、有效突破回落仍P1、sweep 45s降冷却/90s结束、sweep降级后再触发回P1刷p1At、BAT场景P2+曾P1+UNKNOWN命中冷却条件）；旧规则 verify-p1-rule.ts 11/11 无回归；eslint 全绿
- ?reset=1 重挂引擎（K线仓库保留）后真实事件即刻实证：TIA 突破确认进P1(06:38:02)→价格回到区间标假突破→新逻辑降出P1进冷却池→90s结束归档已结束池（行首显示进入P1时刻 06:38:02）；LUMIA 假突破降级后在冷却池稳定展示（曾P1金徽标+147秒前=p1At起算），事件明细完整（MAJOR/P3/曾达P1徽标、疑似假突破风险提示、方向不明隐藏交易按钮）；桌面1440+移动390截图正常
- 全程未重启 server；用户验证期间自开的 LUMIA 20x 多单不受影响（账户对账自洽：总权益=余额+浮亏、ROI 相对初始资金）

Stage Summary:
- 冷却池从「死路」变「活水」：曾达P1 的事件现在有三条真实的降级路径进冷却池——冲高回落（retrace>振幅一半）、假突破（FALSE 标记）、动量衰减（静默45s），且热度回归自动重返P1并刷新 p1At
- P1 池语义回归「紧急」：不再被已回落/已停触发的事件长期占位，异动发生即进、热度过即出
- 池子流转全景：P1（紧急）→ 冷却池（曾P1+方向不明，45-90s观察期）→ 已结束池（MAJOR·曾P1归档）；P2 池只留方向仍明确的事件
---
Task ID: 47
Agent: Super Z (main)
Task: 排查「模拟盘做空 ICP 一秒强平」——强平价公式在 MMR≥IMR 时数学退化（liq=开仓价，开仓即强平）+ 误强平损失还原

Work Log:
- 复现取证：DB 流水 OPEN_SHORT@07:30:32.954（ICP 价 3.195、qty=31,050.95、margin 4960.39、20x、名义 9.92 万U）→ 177ms 后 LIQUIDATE@3.195——强平价与开仓价完全相同、价格未动即被强平；账户余额被吞至 0.0061
- 根因（两层叠加）：①逐仓强平价公式 空=E(1+IMR)/(1+MMR) 在 IMR=MMR 时分子分母相消，强平价=开仓价（mark≥liq 开仓瞬间成立）；20x 的 IMR=0.05 恰与 DEFAULT_TIERS 第 3 档（名义≤10万U）MMR=0.05 相撞——正是本单参数；②更糟的隐藏形态：旧第 4 档 MMR=0.1>IMR 时空单强平价低于开仓价/多单高于开仓价（开仓必然命中），即「20x+名义>10万U」任何空单都会开仓即强平。扫描证实 600 组合（1~20x×1千~100万U×多空）中 115 个违例
- 修复①MMR 档位校准：DEFAULT_TIERS 5%/10% 两档（超出币安真实山寨水平）降至 0.5%/1%/2.5%/5%，对齐币安 USDT-M 真实档位；BTC/ETH 专属档位不动（最高 0.02 恒低于 20x IMR=0.05，无退化风险）
- 修复②公式钳制防御：liqPriceFor 内 mmr=Math.min(mmrFor(symbol,notional), imr/2)——真实交易所通过限制大名义标的最大杠杆保证 IMR>MMR，模拟盘以 MMR≤IMR/2 钳制近似同一约束，强平价距开仓价至少半个初始保证金率的精确下界 (1±IMR)/(1∓IMR/2)；注释完整落档退化数学与修复原理；前端 trade-modal 与服务端同源自动生效
- 验证：scripts/verify-liqprice-rule.ts 12/12——事故场景复现（ICP 修复后强平价 3.2729=+2.44%）、反转场景钳制（20x+20万U 空单 +2.44%/多单 −2.56%）、600 组合零违例、BTC 档位行为不变（−4.04% 精确值断言）；初版断言 4 处口径错误（IMR/2 当距离下界、注释抽查值当真值）修正后全绿
- 损失还原 scripts/migrate-liqprice-fix.ts：ICP 仓 LIQUIDATED→OPEN、删除 LIQUIDATE 流水、退回保证金 4960.39（余额 0.0061→4960.40）、强平价按新公式重算 3.195→3.2729；全部存量 OPEN 仓位强平价重算（本单为唯一误强平，diag-all-liquidations.ts 扫描 LIQUIDATE 全表偏离=0.00% 确认）；API 复核：ICP 空单在持仓（mark 3.226、真实浮亏 −962.58/ROE −19.41% 为市价波动非 bug）、总权益 8958.21 对账自洽（可用 4960.40+保证金 4960.39+浮亏 962.58）；LIQUIDATE 流水无 balance 动作（保证金全损语义）确认账目自洽
- eslint 全绿；全程未重启 server（futures.ts 前后端引用模块热重载生效；paper.ts 未改）

Stage Summary:
- 一秒强平根因修复：强平价公式增加 MMR≤IMR/2 钳制 + 山寨 MMR 档位校准至币安真实水平，1~20x×全名义×多空 600 组合强平价方向恒正确且距离≥钳制精确下界，退化/反转形态彻底杜绝
- 用户 4960.39U 误强平保证金全额退回，ICP 空单原样恢复（含重算后的合理强平价 3.2729），后续按正常市价规则运作
- 教训落档：公式类代码必须对参数边界做退化扫描（本次 IMR=MMR 的相撞是「合法输入参数」触发的数学边界，单元扫描比抽查更能拦住）

---
Task ID: 48
Agent: Super Z (main)
Task: 按用户要求收紧「最大可开」——单仓保证金上限 50%（强平价公式冻结不动）

Work Log:
- 背景：Task 47 已修复强平价公式退化（MMR≤IMR/2 钳制）并退还误强平保证金；用户确认思路——「高仓位不能维持保证金导致的强平，那就把最大可开减少一点；强平价按币安规则就不用动」。本次只收紧开仓口径，强平价公式零改动
- futures.ts（客户端/服务端同源）：新增 PAPER_MAX_MARGIN_RATIO=0.5 与 maxOpenableMargin(available, leverage)=min(余额×50%, 余额/(1+杠杆×费率)) 向下取整到分——前端「最大可开」展示与服务端拒绝阈值由本函数唯一提供，杜绝两处漂移；文件头规则行与 liqPriceFor 注释同步标注「Task 48 后公式冻结不动，风险控制由单仓上限承担」
- paper.ts open()：在仓位数校验后新增单仓上限校验——margin > maxOpenableMargin(余额, 杠杆) 即拒绝，报错文案「超出单仓上限：保证金最高 X USDT（可用余额的 50%），可平仓回笼资金或充值后再开」；加仓合并场景同样只约束本次新增部分；单例 key bump v4→v5（无内存状态，重建安全）
- trade-modal.tsx：maxMargin 改调同源 maxOpenableMargin（原为全额余额/(1+费率)）；错误文案改为「单仓上限为可用余额的 50%」；脚注补「单仓保证金上限50%」；修复预设档浮点伪影边界——balance×0.5 实算 2480.1999999999998 类值会低于分位上限导致 50% 档误报超限，presetMargin 与 maxOpenableMargin 均加 1e-9 伪影护栏后 floor
- 单测 scripts/verify-position-cap.ts 13/13：基准值（事故级余额 4960.40→2480.20 / 初始 10→5.00 / 0/负数/NaN 边界）、160 组合扫描（20 杠杆×8 档余额：比例上限恒成立、手续费预留仍成立、分位取整、只紧不松）、满上仓强平最大损失=保证金≤余额一半、liqPriceFor 回归护栏（ICP 空 3.272927/多 3.115385/BTC 95.382153/500 万U 钳制 1.024390——Task 47 定稿值零漂移）；旧规则 verify-liqprice-rule.ts 12/12 无回归
- API 实测（账户已重置为 10 USDT 干净态）：margin 6 @20x → 400 拒绝「保证金最高 5.00 USDT（可用余额的 50%）」；margin 5.01 → 拒绝；margin 5.00 贴边 → 成交（BTC 20x 名义 100U 强平价 80046.09=−4.62% 币安公式照常）→ 立即平仓还原，对账 10−0.1 费=9.90 严丝合缝
- 浮点伪影 bug 为单测抓出（首版 3 断言失败：4960.4×0.5 floor 丢一分钱），修复后全绿——验证了「公式类代码必须做参数边界扫描」教训
- 前端实证：手动开仓弹窗「可用 9.90 · 最大可开 4.95」，点「最大」档即 4.95（名义 99U，不再是全额 9.90→名义 198U），脚注「单仓保证金上限50%」；桌面 1440+移动 390 截图正常（scripts/task48-cap-*.png）
- eslint 全绿；全程未重启 server（lib+组件热重载，paper key bump 后路由自动重建引擎实例）

Stage Summary:
- 「最大可开」语义变更：从「全额余额预留手续费」收紧为「可用余额 × 50%」——单仓被强平的最大损失=保证金≤可用余额一半，全仓梭哈一把打穿账户的形态彻底关闭；充值后上限随余额水涨船高
- 强平价公式冻结：liqPriceFor 保持币安逐仓精确式（Task 47 定稿），回归护栏单测确保后续改动零漂移
- 同源纪律：maxOpenableMargin 为前端展示与服务端校验的唯一真源，位于 futures.ts 防两处漂移

---
Task ID: 49
Agent: Super Z (main)
Task: 按用户反馈放开单仓上限——从 50% 回到「几乎全仓」（余额预留手续费后可拉满），强平价公式继续冻结

Work Log:
- 用户反馈「50 也太少了 改成之前的几乎全仓的模式吧」；因 Task 48 已把上限做成同源常量，本次只改 PAPER_MAX_MARGIN_RATIO 0.5→1 一个数字：maxOpenableMargin 在比例=1 时手续费上限恒主导，数学上与初版公式 min 侧完全一致（余额/(1+杠杆×费率) 向下取整到分）；注释落档演变史（Task 48 收紧→Task 49 放开）与「未来再调只改一个数字」
- paper.ts / trade-modal.tsx 报错文案与脚注条件化：比例<1 时显示「可用余额的 X%」与「单仓保证金上限X%」，=1 时回初版口径「需预留开仓手续费」且脚注不再显示比例字样
- 单测 verify-position-cap.ts 重写为比例=1 口径 14/14：基准锚点（10→9.90、4960.40→4911.28、1x→4957.92、余额 3→2.97 仍可开）、160 组合与初版公式逐分一致 + 满上扣款 9.999≤10 真·拉满、liqPriceFor 护栏（ICP 空 3.272927/多 3.115385/BTC 95.382153/钳制 1.024390）确认 Task 48/49 两次改动零触碰强平价；verify-liqprice-rule.ts 12/12 无回归
- 踩坑实证（API 层）：改 paper.ts 后首次实测服务端仍按 50% 拒绝（「保证金最高 4.95（可用余额的 50%）」）而前端已显示 9.80——单例 key 未 bump，v5 旧实例方法闭包绑着旧模块图的 50% 版 maxOpenableMargin，与 Task 44 僵尸 collector 同型。bump v5→v6 后立刻生效。教训强化：改 PaperEngine 类方法（哪怕只是方法内引用的纯函数版本）必须 bump key
- API 三路径复测（余额 9.90）：9.81 → 拒「保证金最高 9.80 USDT（需预留开仓手续费）」；9.80 贴边 → 成交（BTC 20x 名义 196U 几乎全仓、强平价 79651.21=−4.62% 币安公式照常）→ 平仓还原，对账 9.9−0.196=9.704 自洽
- 前端实证：「可用 9.90 · 最大可开 9.80」，「最大」档即 9.80（名义 196U），脚注恢复初版文案；桌面 1440+移动 390 截图（scripts/task49-fullmargin-*.png）；eslint 全绿；全程未重启 server

Stage Summary:
- 「最大可开」回到几乎全仓口径：单仓最高 = 余额预留开仓手续费后全额（与初版一致），PAPER_MAX_MARGIN_RATIO=1 保留为未来调节旋钮（改一个数字前后端+文案自动跟随）
- 强平价公式连续两次改动（Task 48 收紧/Task 49 放开）零触碰，回归护栏单测持续锁死 Task 47 定稿值
- 单例坑再实证：改引擎类方法引用的任何依赖都必须 bump key，前端正常≠服务端生效（两端热重载机制不同），API 实测不可省

---
Task ID: 50
Agent: Super Z (main)
Task: 异动交易页签扫描标的从现货切换到 USDT-M 合约——多源发现异动（币安/Bybit/Gate）+ 单源供价，品种白名单 = 币安 U 本位永续（用户定版）

Work Log:
- 用户定版三条规则：①异动多源（Gate/Bybit 行情大差不差、异动方向一致，作冗余容灾）②价格单源（防拼源假异动）③品种只做币安包含的（模拟盘规则本体是币安 USDT-M）
- 探测三所合约 API 可达性与字段（scripts/probe-futures-sources.ts）：币安 fapi 525 永续（ticker/price 含交割带下划线需滤）、Bybit linear 798（instruments 分页 2 页、tickers 自带 24h 统计、备用域名 bytick 可用）、Gate 1040（BTC_USDT 下划线命名、无 1000 前缀、原始单位）；fapi1/2 是 302 不可用、api.gate.com 死
- 新建 futures-feeds.ts：三所适配器统一归一化（Gate BTC_USDT→BTCUSDT；K 线统一升序/毫秒/qv 计价额；Bybit kline 倒序反转、interval '1m'→'1'；Gate t 秒→毫秒、sum→qv）；fetchInstruments/fetchPrices/fetch24h/fetchKlines(startMs/endMs 双向翻页)
- 新建 futures-collector.ts：品种白名单=币安 instruments（PERPETUAL+USDT+TRADING）；每源独立价格史（75min 窗口同现货工艺）+24h 差分 vol1m；rebuildMerged 按优先级选「未挂起+15s 新鲜」的源供价（绝不混源）；源失败 failStreak≥4 挂 60s，418/429 直接挂 180s；启动回填 Top120 播种 chg1m（只写实际供 K 线的源，保持单源不变式）；单例 __binanceRadarFutures_v1 + 稳定别名 Active（Task 44 规则）
- enhanced 引擎切合约：klines.ts KlineStore 换 fetchKlinesFor + market='futures' 标签（热重置携带守卫防现货/合约 K 线混用）；engine.ts 删现货 exchangeInfo、tickSizeOf 走 collector、boot 先拉起合约采集器、单例 bump v2（v1 现货实例停表不携带仓库）；EnhancedStats.sources 三源健康
- paper.ts markPrice：合约 feed 优先 + 现货兜底（遗留现货持仓仍可计价平仓），kickFeeds 在 snapshot/open/close/closeAll 拉起合约采集器（模拟盘是默认页签也保活），单例 bump v7（改取价链路必须 bump 的既训）
- API：新增 /api/enhanced/tickers（合约行情快照）；/api/market/klines 加 market=futures（合约多源 K 线，现货默认不变）；前端 useFuturesTickers + useKlines market 参；TradeModal/CoinDialog 加 market prop（enhanced 页传 futures，弹窗显示「行情源 XX」实际供价源）；enhanced-view 状态条「USDT-M 合约」+ 三源健康灯；页脚文案更新
- 踩坑与修复：①冷启动回填突发触发币安 fapi HTTP 418 短封禁（实测该 IP 对 fapi 有比 2400/min 更严的隐性限制，稳态仅 161/min 也被间歇封）→ 三层防护：bootGapMs 200→1500（峰值权重压至 ~400/min）、collector 回填节流 300ms×2 并发、418/429 直接挂 180s + klineSourceOrder 跳过挂起源（封禁期 K 线自动走 Bybit/Gate 不撞墙）→ 复测 100s 零错误
- API 实测：/api/enhanced/tickers 522 品种全币安供价（1000SHIBUSDT 等合约独有品种在列、USDCUSDT 已剔除）；引擎 120/120 回填、基线就绪、事件池产出（BTW/TIA/ZEC/1000RATS 等）；418 封禁窗口内 BTW 曾自动由 Bybit 供价并显示「行情源 Bybit」，解封后自动回币安——降级→恢复闭环实证；开仓 1000SHIBUSDT（现货无此符号，证明 markPrice 已切合约）→ 强平价=entry×0.9/0.995（IMR10%+低档MMR0.5% 钳制正确）→ 平仓对账：10.009284−0.02 双边费=9.989284 自洽；账户系用户真实使用中（充值5000/余额0.009），测试以最小充值 10U 进行未动历史数据
- 桌面 1440 + 移动 390 截图（scripts/task50-futures-*.png）；eslint 全绿；server 未重启

Stage Summary:
- 异动交易页签全面合约化：扫描/事件/K线/开仓/强平全部跑在 USDT-M 永续上，品种范围=币安白名单（522 个，稳定币对与代币化股票已剔除）
- 多源异动+单源供价落地：币安>Bybit>Gate 优先级、源级容灾自动降级恢复、同符号短窗涨跌只算单一来源（拼源假异动根除）、UI 透明展示实际供价源与三源健康
- 限频治理成型：冷启动权重错峰 + 418/429 长挂起 + 封禁期取数自动绕行，三层防护后实测零错误
- 现货链路（模拟盘页签异动监控、现货 K 线图）零改动回归通过

---
Task ID: 51
Agent: Super Z (main)
Task: ①币安 418 封禁取证分析 ②按用户定版实施分片限流（币安 Top125，其余 ~400 由 Bybit/Gate 平分）③撤销模拟盘页签，模拟建仓系统并入升级版异动交易单页

Work Log:
- 封禁取证（全程被动，未重跑回填/重置）：418 是 IP 自动封禁（封禁期内不看实时权重，权重仅 52 也全拒）；引爆点 = Task 50 冷启动「双回填并发」（引擎 120 标的×2页×权重5 ≈ 3000-4000 权重/min 超 2400 上限 + collector 4 并发零间隔叠加），429 被无视（无退避）→ 升级 418；验证期多次 ?reset=1 在封禁刚解除时又启新回填 → 屡犯封禁时长递增
- 分片实施（用户定版：币安只监控 125 个、其余 400 个两所平分、只做异动价格精度不重要）：
  - futures-feeds.ts 新增币安全局权重令牌桶（容量 80、补充 8/s ≈ 480 权重/min，按端点估算权重扣减：price 2 / 24hr 全量 40 / exchangeInfo 10 / klines 1/2/5/10）——事前限速，从机制上杜绝再触 418
  - futures-collector.ts 新增分片：assignShards() 在 boot 后首次统计就绪时分配一次（运行期不重排防 K 线跨源拼接）——币安 Top125（rankKey 优先币安自身 qv，封禁期退 Bybit/Gate 口径排序）、其余双所覆盖交替发牌 ~200/200、单所覆盖归该所、两所都不覆盖（如 1000SHIBUSDT：Bybit 已无此合约、Gate 命名不同）回币安兜底（实测归属 143/208/171）
  - 供价与 K 线主源都跟归属走（homeOf 优先，源挂掉临时降级其它源）；币安 24hr 轮询 30s→60s（vol 差分 dt≈1min 仍在有效窗口），Bybit/Gate 维持 30s
  - 24h 成交额跨源取 max 统一门槛/分层口径（Gate/Bybit 口径系统性低于币安，按供价源口径会误杀长尾；vol1m/量比保持供价源内部口径与 K 线基线自洽）
  - collector bump v2 + 构造器状态交接（继承 v1 三源清单/价格史/统计/量能基线/分片）——封禁期重建不丢白名单、不重复回填；backfillTop 跳过已有 ≥20 价格点的标的
- 单页合并：page.tsx 撤双页签直渲染 EnhancedView（标题改「USDT-M 合约异动 · 一键交易 · 模拟建仓」）；enhanced-view 引入完整版 PaperPanel（账户总览+当前持仓+平仓流水+充值/重置/手动开仓）替代精简版 PositionsPanel；删除 scanner-view.tsx / anomaly-monitor.tsx / positions-panel.tsx 三个退役组件；状态条展示三源分片归属数 + tooltip 供价明细；页脚文案更新
- 被动验证：分片归属 143/208/171 ✓；币安封禁期 143 个归属品种自动由 Bybit 代供（供价 0/333/171），引擎照常满转（38 条活跃事件、P1 池 18 条主流品种、已结束 43 条）✓；1000SHIBUSDT 封禁期缺席属设计行为（仅币安覆盖，解封自动回归）✓；qv24=max 口径实证（FETUSDT 290万=Bybit 口径）✓；长尾符号封禁期在二线所口径下暂低于 10 万展示门槛、解封后自愈 ✓；单页桌面双屏截图（task51-merged-*.png）；eslint 全绿；server 未重启、未发任何 reset

Stage Summary:
- 币安出站被双重锁死：分片（K 线回填/轮换仅覆盖 Top125 归属）+ 令牌桶（全部 fapi 请求 ≤480 权重/min），解封后稳态 ≈ price 24 + 24hr 40 + rotate ~60 ≈ 124/min，冷启动回填 ~1250 权重被桶平滑到 ~3-4 分钟
- 封禁自愈链完整：418 → 180s 挂起 → 行情/K线自动降级 Bybit/Gate → 解封自动回归币安归属；用户全程无感（引擎事件流未中断）
- 单页信息架构成型：异动事件池（P1/P2/冷却/已结束）+ 事件明细 + 模拟建仓系统同屏，模拟盘页签退役
- 待观察：币安解封时间不可控（屡犯递增），180s 试探会自动发现；解封后验证总数回 ~522 与币安归属供价恢复
