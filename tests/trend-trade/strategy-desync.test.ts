// ---------- Task 82 回归测试：策略装配失配 fail-safe（未知算法绝不静默兜底） ----------
// 背景（实测故障）：strong-trend-v1 上线当晚，dev 进程早于算法注册启动——control 路由
// （HMR 新模块图）的 isKnownStrategy 校验通过并把 strategyId 写进 DB，但常驻引擎单例的
// 旧注册表不认识该 id，createStrategy 静默兜底回 short-swing-v1 → tick 自愈每 10s 重装配
// 又兜底（10 分钟 62 条「策略自愈切换」日志死循环），切换后新仓全部由旧算法开出，
// 而 UI 读 DB 显示「已切换」——「配置 A、实际 B」的隐形错配。
// 本组测试钉死修复后的语义：
//   T-D1  setStrategyId 对本进程未注册的算法抛错（DB 不写入）——切换在源头被拒
//   T-D2  boot/tick 自愈遇到未注册算法：保留实例 + 置 desync + lastError 暴露 + 停开新仓
//   T-D3  正常切换（已注册算法）不受影响：实例换上 + DB 更新 + desync 清空
//   T-D4  desync 恢复：配置改回已注册算法后自愈换上、错误清空、开仓恢复

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';

// ⚠️ 测试库隔离：bunfig.toml [test].preload 在任何测试文件加载前把 DATABASE_URL 指向
// 独立测试库——不触碰 db/custom.db（与 auto-trader.test.ts 同机制）。
const TEST_DB_URL = 'file:/home/z/my-project/db/trend-trade-test.db';

import { AutoPaperTrader } from '@/lib/market/trend-trade/auto-trader';
import { trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { DEFAULT_STRATEGY_ID } from '@/lib/market/trend-trade/strategy/registry';
import { PaperEngine, PaperError } from '@/lib/market/paper';
import { TAKER_FEE, liqPriceFor } from '@/lib/market/futures';
import { db as client } from '@/lib/db';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';

beforeAll(() => {
  execSync('bunx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    cwd: '/home/z/my-project',
    stdio: 'pipe',
  });
});

// ============ 迷你模拟撮合引擎（与 auto-trader.test.ts 同款，仅供测试驱动） ============

const db = client;

class FakePaperEngine extends PaperEngine {
  marks = new Map<string, number>();
  constructor() {
    super(TREND_TRADE.ACCOUNT_NAME);
  }
  private priceOf(symbol: string): number {
    return this.marks.get(symbol) ?? 0;
  }

  override async open(input: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    leverage: number;
    margin: number;
  }) {
    const price = this.priceOf(input.symbol);
    if (price <= 0) throw new PaperError('未知交易对或行情未就绪');
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (!acc) throw new PaperError('账户未初始化');
    const fee = input.margin * input.leverage * TAKER_FEE;
    if (input.margin + fee > acc.balance) {
      throw new PaperError(`可用余额不足：需 ${input.margin.toFixed(2)} + 手续费 ${fee.toFixed(2)}`);
    }
    const notional = input.margin * input.leverage;
    const qty = notional / price;
    const liqPrice = liqPriceFor({
      symbol: input.symbol,
      side: input.side,
      entry: price,
      leverage: input.leverage,
      notional,
    });
    const [pos] = await db.$transaction([
      db.paperPosition.create({
        data: {
          accountId: acc.id,
          symbol: input.symbol,
          base: input.symbol.replace(/USDT$/, ''),
          side: input.side,
          leverage: input.leverage,
          margin: input.margin,
          qty,
          entryPrice: price,
          liqPrice,
          openFee: fee,
        },
      }),
      db.paperAccount.update({
        where: { id: acc.id },
        data: { balance: { decrement: input.margin + fee } },
      }),
      db.paperTrade.create({
        data: {
          accountId: acc.id,
          symbol: input.symbol,
          action: input.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
          price,
          qty,
          fee,
          pnl: 0,
        },
      }),
    ]);
    return {
      id: pos.id,
      symbol: pos.symbol,
      base: pos.base,
      side: input.side,
      leverage: pos.leverage,
      margin: pos.margin,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      markPrice: price,
      liqPrice: pos.liqPrice,
      notional,
      unrealizedPnl: 0,
      roePct: 0,
      openedAt: pos.openedAt.toISOString(),
    };
  }

  override async close(positionId: string) {
    const pos = await db.paperPosition.findUnique({ where: { id: positionId } });
    if (!pos || pos.status !== 'OPEN') throw new PaperError('该仓位已平仓或已清算');
    const mark = this.priceOf(pos.symbol);
    if (mark <= 0) throw new PaperError('行情暂不可用，请稍后再试');
    const sign = pos.side === 'LONG' ? 1 : -1;
    const gross = (mark - pos.entryPrice) * pos.qty * sign;
    const closeFee = mark * pos.qty * TAKER_FEE;
    const netPnl = gross - closeFee - pos.openFee;
    await db.$transaction([
      db.paperPosition.update({
        where: { id: pos.id },
        data: { status: 'CLOSED', exitPrice: mark, pnl: netPnl, closeFee, closedAt: new Date() },
      }),
      db.paperAccount.update({
        where: { id: pos.accountId },
        data: { balance: { increment: pos.margin + gross - closeFee } },
      }),
      db.paperTrade.create({
        data: {
          accountId: pos.accountId,
          positionId: pos.id,
          symbol: pos.symbol,
          action: pos.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
          price: mark,
          qty: pos.qty,
          fee: closeFee,
          pnl: netPnl,
        },
      }),
    ]);
    return { pnl: netPnl, symbol: pos.symbol, side: pos.side, price: mark };
  }

  override async liquidationCheck(accountId: string): Promise<void> {
    const open = await db.paperPosition.findMany({ where: { accountId, status: 'OPEN' } });
    for (const p of open) {
      const mark = this.priceOf(p.symbol);
      if (mark <= 0) continue;
      const hit = p.side === 'LONG' ? mark <= p.liqPrice : mark >= p.liqPrice;
      if (!hit) continue;
      await db.paperPosition.update({
        where: { id: p.id },
        data: { status: 'LIQUIDATED', exitPrice: p.liqPrice, pnl: -p.margin, closedAt: new Date() },
      });
      await db.paperTrade.create({
        data: {
          accountId,
          positionId: p.id,
          symbol: p.symbol,
          action: 'LIQUIDATE',
          price: p.liqPrice,
          qty: p.qty,
          fee: 0,
          pnl: -p.margin,
        },
      });
    }
  }
}

// ============ 统一信号构造（与 auto-trader.test.ts 同款最小夹具） ============

let barClock = Date.now() - 300_000;

function sig(partial: {
  symbol: string;
  phase: string;
  score?: number;
  er?: number;
  dataFresh?: boolean;
}): UnifiedTrendSignal {
  barClock += 60_000;
  const dir =
    partial.phase === 'CONFIRMED_UP' ? 'up' : partial.phase === 'CONFIRMED_DOWN' ? 'down' : 'flat';
  return {
    symbol: partial.symbol,
    market: 'futures',
    interval: '1m',
    phase: partial.phase as UnifiedTrendSignal['phase'],
    direction: dir,
    trendCycleId: `${partial.symbol}:${dir === 'up' ? 'L' : dir === 'down' ? 'S' : 'X'}:${barClock}`,
    trendStartedAt: partial.phase.startsWith('CONFIRMED') ? Date.now() - 15_000 : null,
    endPendingSince: null,
    endEvidenceBars: 0,
    endedAt: null,
    endReason: null,
    score: partial.score ?? 80,
    strength: 0.6,
    confirmCount: 3,
    features: {
      atr: 1, atrPct: 1.2, realizedVolPct: 40, volPercentile: 0.7, volRegime: 'HIGH',
      efficiencyRatio: partial.er ?? 0.5, upperWickPct: 0.1, lowerWickPct: 0.1,
      breakout: 'none', falseBreakout: false, barsUsed: 480,
    },
    htf5m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 96 },
    htf15m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 32 },
    htfAgree: true,
    lastBarTime: barClock,
    lastKlineAt: barClock,
    dataFresh: partial.dataFresh ?? true,
    dataUnavailableReason: partial.dataFresh ?? true ? null : '测试：行情过期',
    anomaly: { dir: null, level: null, priority: null, active: false, lastAt: null },
    conflict: false,
    reason: '测试信号',
    changedAt: barClock,
  } as UnifiedTrendSignal;
}

function makeTrader(signals: UnifiedTrendSignal[], engine: FakePaperEngine): AutoPaperTrader {
  return new AutoPaperTrader(
    { getSignals: () => signals, markPrice: (symbol) => engine.marks.get(symbol) ?? 0 },
    { engine, noTimer: true },
  );
}

async function resetDb(): Promise<void> {
  await client.$executeRawUnsafe(`DELETE FROM PaperTrade`);
  await client.$executeRawUnsafe(`DELETE FROM PaperPosition`);
  await client.$executeRawUnsafe(`DELETE FROM PaperAccount`);
  await client.$executeRawUnsafe(`DELETE FROM TrendAutoConfig`);
  await client.$executeRawUnsafe(`DELETE FROM TrendTradeMeta`);
  await client.$executeRawUnsafe(`DELETE FROM TrendAutoDecision`);
  await client.$executeRawUnsafe(`DELETE FROM TrendPendingEntry`);
  await client.$executeRawUnsafe(`DELETE FROM TrendStrategyState`);
  await client.$executeRawUnsafe(`DELETE FROM TrendWatchSymbol`);
}

async function seedRunningConfig(): Promise<void> {
  await trendTradeRepo.seedConfig({
    name: TREND_TRADE.ACCOUNT_NAME, mode: 'RUNNING', initialCapital: 100,
    marginRatio: 0.2, leverage: 20, maxPositions: 3, slippageBps: 2, peakEquity: 0,
  });
}

/** 本进程（以及任何进程）都不会注册的算法 id */
const GHOST_ID = 'ghost-strategy-not-registered';

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('Task 82 策略装配失配 fail-safe（未知算法绝不静默兜底）', () => {
  test('T-D1 setStrategyId 未注册算法：抛错 + DB 不写入 + 实例保持', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    const trader = makeTrader([], engine);
    await trader.ensureStarted();
    expect(trader.runningStrategyId).toBe(DEFAULT_STRATEGY_ID); // boot 正常装配默认算法

    await expect(trader.setStrategyId(GHOST_ID)).rejects.toThrow('未在当前进程注册');
    // DB 未被污染（拒绝发生在写入之前——旧故障正是先写库后装配失败）
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    expect(cfg?.strategyId ?? DEFAULT_STRATEGY_ID).not.toBe(GHOST_ID);
    // 实例未动、无失配状态（系统仍在自洽状态：配置与实例一致）
    expect(trader.runningStrategyId).toBe(DEFAULT_STRATEGY_ID);
    expect(trader.strategyDesyncId).toBeNull();
  });

  test('T-D2 boot/自愈遇未注册算法：保留实例 + desync 置位 + lastError 暴露 + 停开新仓', async () => {
    await seedRunningConfig();
    await trendTradeRepo.updateStrategyId(TREND_TRADE.ACCOUNT_NAME, GHOST_ID);
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85 })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted(); // boot 装配 ghost → fail-safe：拒绝兜底、保留默认实例
    expect(trader.runningStrategyId).toBe(DEFAULT_STRATEGY_ID); // 绝不静默换成默认算法冒充
    expect(trader.strategyDesyncId).toBe(GHOST_ID);

    await trader.tick(); // 自愈重试 → 仍装配不了 → fail-safe 保持
    expect(trader.strategyDesyncId).toBe(GHOST_ID);
    // 错误持续可见（总览「最近错误」数据源）
    expect(trader.lastErr).toContain('未在当前进程注册');
    expect(trader.lastErr).toContain('重启');

    // fail-safe 核心：强确认信号在手也不开仓（宁停不错）——含待入场也不建
    await trader.tick();
    const open = await client.paperPosition.findMany({ where: { status: 'OPEN' } });
    expect(open.length).toBe(0);
    const pendings = await trendTradeRepo.loadActivePendings();
    expect(pendings.length).toBe(0);
  });

  test('T-D3 正常切换不受影响：已注册算法实例换上 + DB 更新 + desync 清空', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    const trader = makeTrader([], engine);
    await trader.ensureStarted();
    expect(trader.runningStrategyId).toBe(DEFAULT_STRATEGY_ID);

    await trader.setStrategyId('strong-trend-v1');
    expect(trader.runningStrategyId).toBe('strong-trend-v1');
    expect(trader.strategyDesyncId).toBeNull();
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    expect(cfg?.strategyId).toBe('strong-trend-v1');
  });

  test('T-D4 desync 自愈恢复：配置改回已注册算法 → 实例换上 + 错误清空 + 开仓恢复', async () => {
    await seedRunningConfig();
    await trendTradeRepo.updateStrategyId(TREND_TRADE.ACCOUNT_NAME, GHOST_ID);
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85 })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    expect(trader.strategyDesyncId).toBe(GHOST_ID);

    // 模拟「进程重启后注册表已包含该算法」：配置改回已注册算法 → tick 自愈换上
    await trendTradeRepo.updateStrategyId(TREND_TRADE.ACCOUNT_NAME, 'strong-trend-v1');
    await trader.tick();
    expect(trader.runningStrategyId).toBe('strong-trend-v1');
    expect(trader.strategyDesyncId).toBeNull();
    expect(trader.lastErr).toBeNull(); // 失配解除后成功路径清空错误

    // 开仓恢复（强趋势门槛 score≥85 通过 → 建待入场或直接开仓，二次确认流不阻塞）
    const open = await client.paperPosition.findMany({ where: { status: 'OPEN' } });
    const pendings = await trendTradeRepo.loadActivePendings();
    expect(open.length + pendings.length).toBeGreaterThanOrEqual(1);
  });
});
