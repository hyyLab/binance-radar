// ---------- Task 83 回归测试：退池超时自动离场（信号缺失 ≠ 无限期挂起） ----------
// 背景（实测）：TIA/CASHCAT/ZEREBRO 等持仓标的退池后失去信号，manageExits 原语义
// 「信号缺失不误平仓」→ 仓位无限期挂起，只受强平/人工管理：① 占舱位与保证金挤压
// 新仓开仓；② 20x 杠杆下策略离场评估（含硬止损）不再运行，风险敞口失控。
// 本组测试钉死 Task 83 语义：
//   T-L1 退池宽限内不离场：信号消失 → 计时开始，仓位保留（等待重入池）
//   T-L2 退池超时自动平仓：无信号持续 ≥ 宽限 → exitReason=DELIST_TIMEOUT，舱位释放
//   T-L3 重新入池解除计时：信号恢复 → 计时清空；再次退池重新起算（不继承旧计时）
//   T-L4 在池数据缺失不计时：DATA_UNAVAILABLE 信号仍在信号表内 → 不进入退池流程
//   T-L5 事件循环不参与计时：manageExits(空表, false) 不启动/推进退池计时

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';

// ⚠️ 测试库隔离：bunfig.toml [test].preload 在任何测试文件加载前把 DATABASE_URL 指向
// 独立测试库——不触碰 db/custom.db（与 auto-trader.test.ts 同机制）。
const TEST_DB_URL = 'file:/home/z/my-project/db/trend-trade-test.db';

import { AutoPaperTrader } from '@/lib/market/trend-trade/auto-trader';
import { trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
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

// ============ 统一信号构造（与 strategy-desync.test.ts 同款最小夹具） ============

let barClock = Date.now() - 300_000;

/** 固定周期 id：跨 tick 的转换/复核需要同一趋势周期，barClock 前进只代表新收盘 K 线 */
const CYCLE = 'BTCUSDT:L:T83';

function sig(partial: {
  symbol: string;
  phase: string;
  score?: number;
  er?: number;
  dataFresh?: boolean;
  cycleId?: string | null;
}): UnifiedTrendSignal {
  barClock += 60_000;
  const dir =
    partial.phase === 'CONFIRMED_UP' ? 'up' : partial.phase === 'CONFIRMED_DOWN' ? 'down' : 'flat';
  const cycleDir = partial.phase === 'CONFIRMED_UP' ? 'L' : partial.phase === 'CONFIRMED_DOWN' ? 'S' : 'X';
  return {
    symbol: partial.symbol,
    market: 'futures',
    interval: '1m',
    phase: partial.phase as UnifiedTrendSignal['phase'],
    direction: dir,
    trendCycleId:
      partial.cycleId !== undefined ? partial.cycleId : `${partial.symbol}:${cycleDir}:${barClock}`,
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

const GRACE = TREND_TRADE.DELIST_EXIT_GRACE_MS;

/** 退池计时表（内部状态；时间旅行直接拨表，避免测试真实等待 60 分钟） */
function delistMap(trader: AutoPaperTrader): Map<string, number> {
  return (trader as unknown as { delistSince: Map<string, number> }).delistSince;
}

async function openPositions() {
  return client.paperPosition.findMany({ where: { status: 'OPEN' } });
}

/** 开一笔测试仓（两 tick 流程：建待入场 → push 新收盘 K 线信号 → 复核开仓） */
async function openOnePosition(
  signals: UnifiedTrendSignal[],
  engine: FakePaperEngine,
): Promise<AutoPaperTrader> {
  const trader = makeTrader(signals, engine);
  await trader.ensureStarted();
  await trader.tick(); // 创建待入场
  signals.push(sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })); // 新收盘 K 线
  await trader.tick(); // 复核开仓
  return trader;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('Task 83 退池超时自动离场', () => {
  test('T-L1 退池宽限内不离场：信号消失 → 计时开始，仓位保留', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    signals.length = 0; // 退池：信号表清空
    await trader.tick();
    expect((await openPositions()).length).toBe(1); // 宽限内仓位保留
    expect(delistMap(trader).has('BTCUSDT')).toBe(true); // 计时已启动

    await trader.tick(); // 宽限内再跑一轮
    expect((await openPositions()).length).toBe(1); // 仍不离场
  });

  test('T-L2 退池超时自动平仓：exitReason=DELIST_TIMEOUT，舱位释放', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    signals.length = 0; // 退池
    await trader.tick(); // 计时开始
    expect(delistMap(trader).has('BTCUSDT')).toBe(true);

    // 时间旅行：无信号已持续超过宽限期（真实场景 = 60 分钟无信号）
    delistMap(trader).set('BTCUSDT', Date.now() - GRACE - 1_000);
    await trader.tick();

    const open = await openPositions();
    expect(open.length).toBe(0); // 舱位释放
    const meta = await trendTradeRepo.getMeta(
      (await client.paperPosition.findFirst({ where: { symbol: 'BTCUSDT' } }))!.id,
    );
    expect(meta?.status).toBe('CLOSED');
    expect(meta?.exitReason).toBe('DELIST_TIMEOUT');
    expect(delistMap(trader).has('BTCUSDT')).toBe(false); // 平仓后计时表清除
  });

  test('T-L3 重新入池解除计时；再次退池重新起算', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    signals.length = 0; // 第一次退池
    await trader.tick();
    expect(delistMap(trader).has('BTCUSDT')).toBe(true); // 计时启动

    signals.push(sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })); // 重入池
    await trader.tick();
    expect(delistMap(trader).has('BTCUSDT')).toBe(false); // 计时解除
    expect((await openPositions()).length).toBe(1); // 仓位保留

    signals.length = 0; // 再次退池：必须重新起算，不继承旧计时
    await trader.tick();
    expect(delistMap(trader).has('BTCUSDT')).toBe(true);
    // 新计时仍在宽限内（只过了 0ms）→ 不离场
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
  });

  test('T-L4 在池数据缺失（DATA_UNAVAILABLE）不进入退池计时', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);

    // 信号仍在（池内评估继续），只是数据过期——原「数据缺失永不触发离场」语义保持
    signals.length = 0;
    signals.push(sig({ symbol: 'BTCUSDT', phase: 'DATA_UNAVAILABLE', dataFresh: false }));
    await trader.tick();
    expect(delistMap(trader).size).toBe(0); // 不计时
    expect((await openPositions()).length).toBe(1); // 不离场
  });

  test('T-L5 事件循环路径（空信号表 + delistCheck=false）不启动退池计时', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);

    // MAJOR 事件循环每秒调 manageExits(new Map(), false)：无信号但不得碰计时表
    await (trader as unknown as { manageExits(m: Map<string, unknown>, check: boolean): Promise<void> }).manageExits(
      new Map(),
      false,
    );
    expect(delistMap(trader).size).toBe(0); // 计时权唯一属于主循环信号快照
    expect((await openPositions()).length).toBe(1);
  });
});
