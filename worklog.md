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
