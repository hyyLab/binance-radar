# vendor/universal-trend-engine — 本地构建包说明

本目录是 [hyyLab/universal-trend-engine](https://github.com/hyyLab/universal-trend-engine)（私有）
的**本地构建产物**，通过 Radar `package.json` 的 `"universal-trend-engine": "file:./vendor/universal-trend-engine"`
引入。`bun install` 会将其复制进 node_modules（bun 对 `file:` 依赖执行复制而非链接）。

## 当前固定版本

| 项 | 值 |
|----|----|
| 上游 commit | `755d9a6b02db5ab215c5fce61579a628efb1b806` |
| 上游版本号 | 0.1.0（package.json version） |
| 引入日期 | 2026-10-17 |
| 构建方式 | `bun install && bun run build`（tsc -p tsconfig.json → dist/，ESM NodeNext） |
| 上游测试 | `bunx vitest run` → 7/7 passed（引入时记录） |

## 目录内容

- `package.json` — 上游原样（main/types/exports 指向 dist/；`private: true`；无运行时依赖）
- `dist/` — tsc 编译输出（js + d.ts + sourcemap），**不依赖未构建源码**
- `README.md` — 上游原样
- 本文件 — 上游 commit 标识与同步流程

> 故意**不**包含 `src/`、`tests/`、`tsconfig.json`：运行时只需要 dist/。
> 不要直接依赖没有 dist/ 的 GitHub 包并假定安装过程会自动构建——上游无 prepublish 构建
> 钩子，本目录的存在就是为了保证「装进来的就是构建过的」。

## 从上游更新版本的同步流程

```bash
# 1) 克隆/拉取上游（私有仓库，需 token）
git clone https://github.com/hyyLab/universal-trend-engine.git .tmp-ute-src
cd .tmp-ute-src
git checkout <目标 commit>          # 固定到经过审阅的 commit

# 2) 构建并跑上游测试（测试不过不引入）
bun install
bun run typecheck
bunx vitest run                     # 上游自带 7 个测试

# 3) 替换 vendor 内容（保留本文件并更新上表）
cd /home/z/my-project
rm -rf vendor/universal-trend-engine/dist
cp -r .tmp-ute-src/dist .tmp-ute-src/package.json .tmp-ute-src/README.md vendor/universal-trend-engine/
# 更新本文件「当前固定版本」表中的 commit / 日期 / 测试结果

# 4) 刷新 lockfile 并验证
rm -rf node_modules/universal-trend-engine
bun install
bun test tests/trend-watch/         # Radar 侧集成测试必须全绿

# 5) 清理临时克隆
rm -rf .tmp-ute-src
```

## 集成纪律

- **不复制、不改写、不另行实现** UTE 的趋势判断算法——Radar 只 import 其公开 API
  （`scanAnomalyCandidates` / `toClosedBars` / `DEFAULT_TREND_CONFIG` / `resolveTrendConfig` /
  `createTrendState` / `updateTrendState` 及类型）。
- 算法缺陷 → 上游提 commit；Radar 侧只做数据整形与门控。
- 升级前先在历史回放中对比新旧版本输出（确认延迟 / 假阳性 / 漏检），再替换 vendor。
