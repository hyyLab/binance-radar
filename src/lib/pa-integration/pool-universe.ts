// ---------- PA 整合 · 全池统一读取接口（任务书 §3.1/§3.2） ----------
// radar 当前全部包含交易标的的业务池（开发前盘点结论，见 docs/pa-integration-plan.md §1.1）：
//   P1 异动事件池      EnhancedEngine.events().active（内存，state=ACTIVE）
//   P2 趋势观察池      TrendWatchService.snapshot().pool（内存，含 UTE 信号）
//   P3 主动探针通道    观察池内 entryChannel='probe'（同一池的入池通道，独立登记来源）
//   P4 每日热门池      DB HotPoolEntry（date=今天 UTC+8）
//   P5 扫描器宇宙      MarketScanner 宇宙（涨幅榜/跌幅榜/近4h异动，≤200）
//
// 明确排除（页面「扫描范围」同文展示，不静默遗漏）：
//   - 全量合约行情宇宙（futures collector tickers）——行情源，不是业务池；
//   - 现货 / 代币化股票（spot collector）——PA 仅针对 U 本位合约；
//   - AnomalyEvent 历史表、TrendWatchSymbol RETIRED 退池记录、历史日期热门池。
//
// 纪律：本模块只读。所有 getSymbols 内部自捕获异常（单池故障不拖垮全池扫描），
// 池错误通过返回值 error 字段暴露。新增池 = 追加一个 RadarPoolSource 到 POOL_SOURCES。

import { db } from '@/lib/db';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { scanner } from '@/lib/market/scanner';
import type { PoolUniverseEntry, PoolUniverseResult, RadarPoolSource, RadarPoolSymbol } from './types';

/** 今日日期（UTC+8，与 HotPoolEntry 的 date 口径一致） */
function todayCst(): string {
  const now = new Date(Date.now() + 8 * 3_600_000);
  return now.toISOString().slice(0, 10);
}

/** P2+P3：趋势观察池 + 主动探针池（探针池 = 观察池的 probe 通道，同一内存池两种来源） */
function trendWatchPools(): RadarPoolSource[] {
  const readWatchRows = (): ReturnType<ReturnType<typeof getEnhancedEngine>['trendWatch']['snapshot']>['pool'] => {
    try {
      return getEnhancedEngine().trendWatch.snapshot(Date.now()).pool;
    } catch {
      return [];
    }
  };

  return [
    {
      poolId: 'trend-watch',
      poolName: '趋势观察池',
      describe: 'TrendWatchService 候选池（≤20，含 UTE 相位/方向/评分；RETIRED 排除）',
      async getSymbols() {
        return readWatchRows().map((r): RadarPoolSymbol => ({
          symbol: r.symbol,
          poolId: 'trend-watch',
          poolName: '趋势观察池',
          status: r.phaseV2,
          firstSeenAt: r.addedAt,
          lastSeenAt: r.lastKlineAt,
          reason: r.reason,
          dir: r.direction === 'flat' ? null : r.direction,
          score: r.score,
        }));
      },
    },
    {
      poolId: 'probe',
      poolName: '主动探针池',
      describe: '观察池 probe 入池通道（QV/ER/一致性门槛主动纳入的标的）',
      async getSymbols() {
        return readWatchRows()
          .filter((r) => r.entryChannel === 'probe')
          .map((r): RadarPoolSymbol => ({
            symbol: r.symbol,
            poolId: 'probe',
            poolName: '主动探针池',
            status: r.phaseV2,
            firstSeenAt: r.addedAt,
            lastSeenAt: r.lastKlineAt,
            reason: `探针入池：${r.reason}`,
            dir: r.direction === 'flat' ? null : r.direction,
            score: r.score,
          }));
      },
    },
  ];
}

/** 全部业务池数据源（新增池在此注册；顺序 = 页面展示顺序） */
export function poolSources(): RadarPoolSource[] {
  const sources: RadarPoolSource[] = [];

  // P1 异动事件池
  sources.push({
    poolId: 'anomaly-events',
    poolName: '异动事件池',
    describe: 'EnhancedEngine 活跃异动事件（state=ACTIVE；ENDED/历史表排除）',
    async getSymbols() {
      try {
        const engine = getEnhancedEngine();
        const active = engine.events(Date.now()).active;
        return active.map((e): RadarPoolSymbol => ({
          symbol: e.symbol,
          poolId: 'anomaly-events',
          poolName: '异动事件池',
          status: e.state,
          firstSeenAt: e.firstAt,
          lastSeenAt: e.updatedAt,
          reason: `${e.level}/${e.priority} 异动`,
          dir: e.dir,
        }));
      } catch {
        return [];
      }
    },
  });

  // P2 趋势观察池 + P3 主动探针通道
  sources.push(...trendWatchPools().filter((s) => s.poolId === 'trend-watch'));
  sources.push(...trendWatchPools().filter((s) => s.poolId === 'probe'));

  // P4 每日热门池
  sources.push({
    poolId: 'hot-daily',
    poolName: '每日热门池',
    describe: 'DB HotPoolEntry 当天（UTC+8 成交额Top80+涨幅Top40+跌幅Top40+放量Top20；历史日期排除）',
    async getSymbols() {
      try {
        const rows = await db.hotPoolEntry.findMany({ where: { date: todayCst() }, orderBy: { rank: 'asc' } });
        return rows.map((r): RadarPoolSymbol => ({
          symbol: r.symbol,
          poolId: 'hot-daily',
          poolName: '每日热门池',
          status: (JSON.parse(r.tags || '[]') as string[]).join('+') || 'HOT',
          firstSeenAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt),
          lastSeenAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt),
          rank: r.rank,
        }));
      } catch {
        return [];
      }
    },
  });

  // P5 扫描器宇宙
  sources.push({
    poolId: 'scanner-universe',
    poolName: '扫描器宇宙',
    describe: '机会扫描器宇宙（涨幅Top20+跌幅Top20+近4h异动，≤200；榜单重建自然退出）',
    async getSymbols() {
      try {
        const members = scanner.getUniverseSymbols();
        return members.map((m): RadarPoolSymbol => ({
          symbol: m.symbol,
          poolId: 'scanner-universe',
          poolName: '扫描器宇宙',
          status: m.tags.join('+'),
          firstSeenAt: m.joinedAt,
          lastSeenAt: Date.now(),
        }));
      } catch {
        return [];
      }
    },
  });

  return sources;
}

/** 规整 symbol：仅接受 U 本位合约形态（xxxUSDT；radar 池内全部为 USDT 计价后缀） */
function normalizeFuturesSymbol(raw: string): string | null {
  const s = String(raw || '').toUpperCase().trim();
  if (!s.endsWith('USDT')) return null; // 排除现货非 USDT 计价/其他计价
  const base = s.slice(0, -4);
  if (!base || /[^A-Z0-9]/.test(base)) return null;
  return s;
}

/**
 * 全池读取 + 合并去重（任务书 §3.2）：
 * 同一 symbol 多池命中 → 一个扫描对象 + sourcePools 保留全部来源；
 * 非合约形态（现货/股票代币等）在此规整层剔除并计数（页面展示排除原因）。
 */
export async function readPoolUniverse(): Promise<PoolUniverseResult> {
  const sources = poolSources();
  const pools: PoolUniverseResult['pools'] = [];
  const bySymbol = new Map<string, PoolUniverseEntry>();
  let totalRaw = 0;
  let excludedNonFutures = 0;

  await Promise.all(
    sources.map(async (src) => {
      let rows: RadarPoolSymbol[] = [];
      let error: string | null = null;
      try {
        rows = await src.getSymbols();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      pools.push({ poolId: src.poolId, poolName: src.poolName, count: rows.length, describe: src.describe, error });
      for (const r of rows) {
        totalRaw++;
        const sym = normalizeFuturesSymbol(r.symbol);
        if (!sym) {
          excludedNonFutures++;
          continue;
        }
        let entry = bySymbol.get(sym);
        if (!entry) {
          entry = { symbol: sym, sourcePools: [], poolFirstSeenAt: null, poolLastSeenAt: null };
          bySymbol.set(sym, entry);
        }
        entry.sourcePools.push({ ...r, symbol: sym });
        const fs = r.firstSeenAt;
        const ls = r.lastSeenAt;
        if (fs != null && (entry.poolFirstSeenAt == null || fs < entry.poolFirstSeenAt)) entry.poolFirstSeenAt = fs;
        if (ls != null && (entry.poolLastSeenAt == null || ls > entry.poolLastSeenAt)) entry.poolLastSeenAt = ls;
      }
    }),
  );

  pools.sort((a, b) => a.poolId.localeCompare(b.poolId));
  return { ts: Date.now(), pools, entries: [...bySymbol.values()], totalRaw };
}
