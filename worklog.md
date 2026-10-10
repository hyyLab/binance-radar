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
