// ---------- Task 85 回归测试：退池（信号缺失）持仓由策略内出场条件继续管理 ----------
// 背景（Task 85 回退定版）：Task 83 DELIST_TIMEOUT（宽限超时平仓）与 Task 84
// DELIST_EARLY_EXIT（有利润/小亏立即出）被实盘证伪——cashcat/icnt 两笔在 -7.8%/-9.9%
// 保证金小亏处被「退池提前离场」割掉，随后价格 +4.67%/+10.83%（用户：「退池提前离场
// 可能并不是一个好的策略……我们单独用策略内的条件来判断在退池之后的操作」）。
// 新语义：退池 = 信号缺失 → evaluateExit 以 signal=null 继续运行（接口本就支持）：
//   硬止损（价格 %）/ 移动止盈（mfe 峰值回撤）为纯价格驱动，照常生效；
//   走弱先走等需信号的条件自然跳过；ENDED/反向确认等基础设施离场只在有信号时评估；
//   强平巡检独立兜底。本组测试用 strong-trend-v1（当前实盘算法，止损 1.5% 价格 /
//   移动止盈 30/20 保证金）钉死：
//   T-S1 退池小亏不割：-6% 保证金（旧 Task 84 会 DELIST_EARLY_EXIT）→ 必须继续持有
//        （cashcat/icnt 回归场景：小亏割在黎明前 = 卖飞）
//   T-S2 退池后硬止损继续生效：价格逆行 ≥1.5% → STOP_LOSS（方向选择失败防拖到强平）
//   T-S3 退池后移动止盈继续生效：mfe 武装后回撤超限 → TRAIL_TAKE 锁利
//        （cashcat/icnt 反事实：若当时继续持有，反弹会武装移动止盈并锁定利润）
//   T-S4 退池重入池后基础设施离场恢复：ENDED（同周期+新收盘K线）→ TREND_ENDED
//   T-S5 在池数据断供（DATA_UNAVAILABLE）不误平（语义保持；价格真值驱动的止损不豁免）
//   T-S6 事件循环（空信号表）也评估策略出场：价格驱动离场每秒多一次兜底（Task 85 新语义）

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';

// ⚠️ 测试库隔离：bunfig.toml [test].preload 在任何测试文件加载前把 DATABASE_URL 指向
// 独立测试库——不触碰 db/custom.db（与 auto-trader.test.ts 同机制）。
const TEST_DB_URL = 'file:/home/z/my-project/db/trend-trade-test.db';

import { AutoPaperTrader } from '@/lib/market/trend-trade/auto-trader';
import { trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { createStrategy } from '@/lib/market/trend-trade/strategy/registry';
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
const CYCLE = 'BTCUSDT:L:T85';

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

/** strong-trend-v1（当前实盘算法）固定装配：止损 1.5% 价格 / 移动止盈武装 8% 回撤 5%（保证金口径） */
function makeTrader(signals: UnifiedTrendSignal[], engine: FakePaperEngine): AutoPaperTrader {
  return new AutoPaperTrader(
    { getSignals: () => signals, markPrice: (symbol) => engine.marks.get(symbol) ?? 0 },
    { engine, noTimer: true, strategy: createStrategy('strong-trend-v1') },
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

/** 读回唯一持仓的离场原因（断言用） */
async function soleMeta() {
  const pos = await client.paperPosition.findFirst({ where: { symbol: 'BTCUSDT' } });
  return pos ? trendTradeRepo.getMeta(pos.id) : null;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('Task 85 退池持仓由策略内条件管理（signal=null 继续评估）', () => {
  test('T-S1 退池小亏不割：-6% 保证金继续持有（cashcat/icnt 回归钉死，不得 DELIST_EARLY_EXIT）', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    // -0.3% 价格 = -6% 保证金：Task 84 在这里会立即 DELIST_EARLY_EXIT（≤10% 上限），
    // 实盘证伪（cashcat -7.8% 割在底部后 +4.67%）；Task 85 语义 = 交给策略条件判断，
    // -6% 未触发硬止损（-30% 保证金）也未武装移动止盈 → 必须继续持有
    engine.marks.set('BTCUSDT', 99.7);
    signals.length = 0; // 退池：信号表清空
    await trader.tick();
    await trader.tick();
    await trader.tick(); // 多轮 tick 反复确认：不因退池而离场

    expect((await openPositions()).length).toBe(1); // 仓位保留
    const meta = await soleMeta();
    expect(meta?.status).toBe('OPEN');
    expect(meta?.exitReason ?? null).toBeNull(); // 无任何离场原因
  });

  test('T-S2 退池后硬止损继续生效：价格逆行 ≥1.5% → STOP_LOSS（防拖到强平）', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    engine.marks.set('BTCUSDT', 98.4); // -1.6% 价格 ≥ 止损线 1.5%（= -32% 保证金）
    signals.length = 0; // 退池
    await trader.tick();

    expect((await openPositions()).length).toBe(0); // 策略内硬止损照常离场
    const meta = await soleMeta();
    expect(meta?.status).toBe('CLOSED');
    expect(meta?.exitReason).toBe('STOP_LOSS');
  });

  test('T-S3 退池后移动止盈继续生效：mfe 武装（≥30%）后回撤 ≥20% → TRAIL_TAKE 锁利', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    // 在池：价格 +2% = +40% 保证金 → updateOpenStats 落库 mfe=40 ≥ 30（武装，Task 85b
    // 回退后 strong-trend-v1 继承 universal-trend 默认 30/20）；同 tick evaluateExit：
    // peak=40、live=40、giveback=0 → 不触发
    engine.marks.set('BTCUSDT', 102);
    await trader.tick();
    expect((await openPositions()).length).toBe(1);

    // 退池：价格回落至 +0.4% = +8% 保证金 → giveback = 40-8 = 32% ≥ 20 → 移动止盈锁利。
    // （cashcat/icnt 反事实：退池后不割，反弹 +10.83%/+4.67% 会武装移动止盈并锁定利润）
    engine.marks.set('BTCUSDT', 100.4);
    signals.length = 0; // 退池
    await trader.tick();

    expect((await openPositions()).length).toBe(0);
    const meta = await soleMeta();
    expect(meta?.status).toBe('CLOSED');
    expect(meta?.exitReason).toBe('TRAIL_TAKE');
  });

  test('T-S4 退池重入池后基础设施离场恢复：ENDED（同周期+新收盘K线）→ TREND_ENDED', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    engine.marks.set('BTCUSDT', 99.7);
    signals.length = 0; // 退池
    await trader.tick();
    expect((await openPositions()).length).toBe(1); // 退池不离场

    signals.push(sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })); // 重入池
    await trader.tick();
    expect((await openPositions()).length).toBe(1); // 重入池恢复完整评估

    signals.push(sig({ symbol: 'BTCUSDT', phase: 'ENDED', cycleId: CYCLE })); // 同周期结束确认
    await trader.tick();
    expect((await openPositions()).length).toBe(0); // 基础设施 ENDED 离场照常
    const meta = await soleMeta();
    expect(meta?.exitReason).toBe('TREND_ENDED');
  });

  test('T-S5 在池数据断供（DATA_UNAVAILABLE）不误平（语义保持）', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);

    // 信号仍在（池内评估继续），只是数据过期；99.7 未触发价格驱动止损 → 持有
    signals.length = 0;
    signals.push(sig({ symbol: 'BTCUSDT', phase: 'DATA_UNAVAILABLE', dataFresh: false }));
    engine.marks.set('BTCUSDT', 99.7);
    await trader.tick();
    expect((await openPositions()).length).toBe(1); // 不离场
  });

  test('T-S6 事件循环（空信号表）也评估策略出场：价格驱动离场每秒多一次兜底', async () => {
    await seedRunningConfig();
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', score: 85, cycleId: CYCLE })];
    const trader = await openOnePosition(signals, engine);
    expect((await openPositions()).length).toBe(1);

    // 事件循环每秒调 manageExits(new Map())：空表 = 全部按 signal=null 评估（Task 85 新
    // 语义），硬止损/移动止盈在事件循环同样生效——不再依赖主循环 10s 节拍
    engine.marks.set('BTCUSDT', 98.4);
    await (trader as unknown as { manageExits(m: Map<string, unknown>): Promise<void> }).manageExits(
      new Map(),
    );

    expect((await openPositions()).length).toBe(0);
    const meta = await soleMeta();
    expect(meta?.exitReason).toBe('STOP_LOSS');
  });
});
