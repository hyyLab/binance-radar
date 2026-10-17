// ---------- 趋势自动模拟交易 · 行为测试（bun test，独立测试库 + fake 注入） ----------
// Task 56 验收清单（用户定版 §九 20 项）映射：
// T1  手动账户隔离                       §一.8
// T2  sizing = 开仓时权益 × min(20%, 95%÷仓数)（默认 3 仓 = 20%）+ 20x   §一.1/§六（验收 16；Task 58 封顶语义）
// T3  未确认/数据过期不开仓               §一.10（验收 11 部分）
// T4  反向候选/短暂反向不提前平仓         §3.2（验收 6 部分）
// T5  趋势确认结束（ENDED 同周期）正确离场 + 滑点/手续费/净盈亏口径（验收 7/18）
// T6  同周期幂等不重复开仓（含重启）（验收 14）
// T7  数据过期不开新仓、不误判结束（验收 10/19 部分）
// T9  暂停不开新仓（含待入场不转换），持仓仍管理（验收 19）
// T10 重启恢复 reconcile（验收 3 部分）
// T11 最大持仓数约束（验收 17）
// T12 强平如实记录（验收 18 部分）
// T13 反向确认先平后开 + 同币种冷却（验收 15）
// T14 人工平仓/全部平仓 MANUAL 语义
// T15 资金不足跳过并记录 SKIP（§六，验收 16 部分）
// T16 充值
// T17 持仓数量持久化（与每仓保证金解耦）
// T18 END_PENDING 首次迹象不平仓 + firstEndSignAt（验收 6）
// T19 旧 trendCycleId 的 ENDED 不关闭新周期持仓（验收 4）
// T20 重置账户
// T21 权益 20% 保证金 + 手续费超余额 → 跳过（验收 16）
// T22 开仓所在 K 线不能触发该持仓的结束确认（验收 5）
// T23 三根独立收盘 K 线证据期间持仓保持、确认结束才离场（验收 6/7）
// T24 结束迹象恢复（迟滞重置）持仓保持（验收 8）
// T25 入场门槛：低评分/低 ER 不开仓（验收 11）
// T26 高周期过滤：反对/中性严格门槛/数据不足（验收 11/12）
// T27 待入场二次确认：只建记录 → 新收盘 K 线复核 → 只开一次；趋势失效取消（验收 13）
// T28 MFE/MAE 增量更新（验收 18）

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';

// ⚠️ 测试库隔离：bunfig.toml [test].preload（tests/preload-test-db.ts）在任何测试文件
// 加载前把 DATABASE_URL 指向独立测试库——@/lib/db 单例与本文件的 client 绑定同一库，
// 不触碰 db/custom.db。下方 beforeAll 用 prisma db push 同步完整 schema。
const TEST_DB_URL = 'file:/home/z/my-project/db/trend-trade-test.db';

import { AutoPaperTrader } from '@/lib/market/trend-trade/auto-trader';
import { trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE, effectiveMarginRatio } from '@/lib/market/trend-trade/config';
import { ShortSwingStrategy } from '@/lib/market/trend-trade/strategy/short-swing';
import { sanitizeRuntimeParams } from '@/lib/market/trend-trade/console-params';
import { PaperEngine, PaperError } from '@/lib/market/paper';
import { TAKER_FEE, liqPriceFor } from '@/lib/market/futures';
import { db as client } from '@/lib/db';
import type { PrismaClient } from '@prisma/client';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';

beforeAll(() => {
  execSync('bunx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    cwd: '/home/z/my-project',
    stdio: 'pipe',
  });
});

// ============ 迷你模拟撮合引擎（费用/强平口径与生产一致；仅供测试驱动） ============
// db 即 client（同一测试库单例），FakePaperEngine 直接使用

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

// ============ 统一信号构造 ============

let barClock = Date.now() - 300_000; // 近真实时钟（先平后开独立性/冷却用真实平仓时刻比较）

function sig(partial: {
  symbol: string;
  phase: string;
  direction?: 'up' | 'down' | 'flat';
  cycleId?: string | null;
  dataFresh?: boolean;
  score?: number;
  er?: number;
  htf5mDir?: 'up' | 'down' | 'flat';
  htf5mValid?: boolean;
  htf15mDir?: 'up' | 'down' | 'flat';
  htf15mValid?: boolean;
  lastBarTime?: number | null;
}): UnifiedTrendSignal {
  barClock += 60_000;
  const dir =
    partial.direction ??
    (partial.phase === 'CONFIRMED_UP' ? 'up' : partial.phase === 'CONFIRMED_DOWN' ? 'down' : 'flat');
  const cycleDir = partial.phase === 'CONFIRMED_UP' ? 'L' : partial.phase === 'CONFIRMED_DOWN' ? 'S' : 'X';
  return {
    symbol: partial.symbol,
    market: 'futures',
    interval: '1m',
    phase: partial.phase as UnifiedTrendSignal['phase'],
    direction: dir,
    trendCycleId:
      partial.cycleId !== undefined ? partial.cycleId : `${partial.symbol}:${cycleDir}:${barClock}`,
    trendStartedAt: partial.phase.startsWith('CONFIRMED') ? barClock : null,
    endPendingSince: null,
    endEvidenceBars: 0,
    endedAt: partial.phase === 'ENDED' ? barClock : null,
    endReason: partial.phase === 'ENDED' ? 'DECAY' : null,
    score: partial.score ?? 80,
    strength: 0.6,
    confirmCount: 3,
    features: {
      atr: 1, atrPct: 1.2, realizedVolPct: 40, volPercentile: 0.7, volRegime: 'HIGH',
      efficiencyRatio: partial.er ?? 0.5, upperWickPct: 0.1, lowerWickPct: 0.1, breakout: 'none',
      falseBreakout: false, barsUsed: 480,
    },
    htf5m: {
      dir: partial.htf5mDir ?? dir, efficiencyRatio: 0.5, returnPct: 1,
      valid: partial.htf5mValid ?? true, bars: 96,
    },
    htf15m: {
      dir: partial.htf15mDir ?? dir, efficiencyRatio: 0.5, returnPct: 1,
      valid: partial.htf15mValid ?? true, bars: 32,
    },
    htfAgree: true,
    lastBarTime: partial.lastBarTime !== undefined ? partial.lastBarTime : barClock,
    lastKlineAt: barClock,
    dataFresh: partial.dataFresh ?? true,
    dataUnavailableReason: partial.dataFresh ?? true ? null : '测试：行情过期',
    anomaly: { dir: null, level: null, priority: null, active: false, lastAt: null },
    conflict: false,
    reason: '测试信号',
    changedAt: barClock,
  } as UnifiedTrendSignal;
}

/** 推进一根已收盘 K 线（待入场二次确认的等待条件） */
function nextBar(s: UnifiedTrendSignal, at?: number): UnifiedTrendSignal {
  return { ...s, lastBarTime: at ?? (s.lastBarTime ?? barClock) + 60_000, changedAt: Date.now() };
}

/** 保留原信号其余字段（测试内替换相位用） */
function keepSig(s: UnifiedTrendSignal): UnifiedTrendSignal {
  return { ...s };
}

// ============ 测试 ============

function makeTrader(
  signals: UnifiedTrendSignal[],
  engine: FakePaperEngine,
  strategy?: ShortSwingStrategy,
) {
  return new AutoPaperTrader(
    {
      getSignals: () => signals,
      markPrice: (symbol) => engine.marks.get(symbol) ?? 0,
    },
    { engine, noTimer: true, strategy },
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
  await client.$executeRawUnsafe(`DELETE FROM TrendWatchSymbol`);
}

async function openPositions() {
  return client.paperPosition.findMany({ where: { status: 'OPEN' } });
}

/** 开仓（完整二次确认流：tick1 建待入场 → 推进一根 K 线 → tick2 复核开仓） */
async function openViaPending(
  signals: UnifiedTrendSignal[],
  trader: AutoPaperTrader,
  index = 0,
): Promise<void> {
  await trader.tick(); // 创建待入场
  signals[index] = nextBar(signals[index]!);
  await trader.tick(); // 复核开仓
}

/** 回拨某 symbol 最近平仓时刻（模拟冷却结束） */
async function backdateLastClose(symbol: string, minutesAgo: number): Promise<void> {
  await client.$executeRawUnsafe(
    `UPDATE TrendTradeMeta SET closedAt = ? WHERE symbol = ? AND status = 'CLOSED'`,
    new Date(Date.now() - minutesAgo * 60_000),
    symbol,
  );
}

async function activePendings() {
  return trendTradeRepo.loadActivePendings();
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('AutoPaperTrader（趋势自动模拟交易 · Task 56）', () => {
  test('T1 账户隔离：独立账户 trend-auto-v1，不触碰手动 default 账户', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const trader = makeTrader([sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP' })], engine);
    await trader.ensureStarted();
    const accounts = await client.paperAccount.findMany();
    expect(accounts.map((a) => a.name)).toEqual(['trend-auto-v1']);
    expect(accounts[0]!.balance).toBe(TREND_TRADE.INITIAL_CAPITAL); // 初始资金来自配置（可配）
  });

  test('T2 sizing：每仓保证金 = 开仓时账户权益 × 20%（floor2），杠杆 20x，名义 = 保证金 × 20', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:801' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const rows = await openPositions();
    expect(rows.length).toBe(1);
    const expectMargin = Math.floor((100 * TREND_TRADE.MARGIN_RATIO + 1e-9) * 100) / 100; // 20.00
    expect(rows[0]!.margin).toBeCloseTo(expectMargin, 2);
    expect(rows[0]!.leverage).toBe(20);
    expect(rows[0]!.qty * rows[0]!.entryPrice).toBeCloseTo(expectMargin * 20, 1); // 保证金 × 20x 名义
    // 开仓快照（§七）：entryBarTime/htfGate/entryNotional 落库
    const meta = await trendTradeRepo.getMeta(rows[0]!.id);
    expect(meta?.entryNotional ?? 0).toBeCloseTo(expectMargin * 20, 1);
    expect(meta?.htfGate).toBe('ALIGNED');
    expect(meta?.entryBarTime ?? 0).toBeGreaterThan(0);
  });

  test('T3 未确认不开仓：CANDIDATE/OBSERVING/数据过期一律不触发（无持仓无待入场）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    engine.marks.set('XRPUSDT', 2);
    const trader = makeTrader(
      [
        sig({ symbol: 'BTCUSDT', phase: 'CANDIDATE_UP' }),
        sig({ symbol: 'ETHUSDT', phase: 'OBSERVING' }),
        sig({ symbol: 'XRPUSDT', phase: 'CONFIRMED_UP', dataFresh: false }),
      ],
      engine,
    );
    await trader.ensureStarted();
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    expect((await activePendings()).length).toBe(0);
  });

  test('T4 短暂反向不提前平仓（Task 56 语义，策略 WEAKNESS_EXIT_EARLY=false）：反向候选与 END_PENDING 均不触发离场', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:841' })];
    const trader = makeTrader(signals, engine, new ShortSwingStrategy({ WEAKNESS_EXIT_EARLY: false }));
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    expect((await openPositions()).length).toBe(1);
    // 趋势转为反向候选（未确认）——持仓保持
    signals[0] = { ...keepSig(signals[0]!), phase: 'CANDIDATE_DOWN', direction: 'flat', trendCycleId: 'BTCUSDT:S:999' };
    await trader.tick();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    // 同周期 END_PENDING（结束迹象）——策略关闭提前离场时持仓保持（三根 K 线确认前不离场）
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'END_PENDING',
      direction: 'up',
      endEvidenceBars: 1,
      endPendingSince: Date.now(),
      trendCycleId: 'BTCUSDT:L:841',
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
  });

  test('T4b 短周期套利默认策略：同周期 END_PENDING → 提前离场（WEAKNESS_EARLY），走强后可再入场', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:842' })];
    const trader = makeTrader(
      signals,
      engine,
      // 默认策略思路（走弱先走）；REENTRY_MIN_GAP_MS=0：真实时钟不可快进，60s 间隔已由
      // 策略单元测试 S7b 覆盖，这里聚焦轮次化决策键与再入场全链路
      new ShortSwingStrategy({ REENTRY_MIN_GAP_MS: 0 }),
    ); // 默认策略：走弱先走
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    expect((await openPositions()).length).toBe(1);
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
    // 同周期出现结束迹象 → 策略提前离场（不等三根确认）
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'END_PENDING',
      direction: 'up',
      endEvidenceBars: 1,
      endPendingSince: Date.now(),
      trendCycleId: meta.trendCycleId,
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    const m = await trendTradeRepo.getMeta(meta.positionId);
    expect(m?.exitReason).toBe('WEAKNESS_EARLY');
    expect(m?.firstEndSignAt ?? 0).toBeGreaterThan(0);
    // 走强（回到 CONFIRMED 同周期 + 新收盘 K 线）→ 轮次 #R2 再入场
    await backdateLastClose('BTCUSDT', 6); // 模拟 5 分钟冷却已过（基础设施冷却不因轮次绕过）
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'CONFIRMED_UP',
      direction: 'up',
      endEvidenceBars: 0,
      endPendingSince: null,
      trendCycleId: meta.trendCycleId,
      lastBarTime: (signals[0]!.lastBarTime ?? 0) + 600_000, // 新 K 线且远离刚平仓时刻（>60s 间隔）
    };
    await trader.tick(); // 建待入场 R2
    const pend = await trendTradeRepo.getActivePendingBySymbol('BTCUSDT');
    expect(pend?.cycleId).toBe(`${meta.trendCycleId}#R2`);
    signals[0] = { ...signals[0]!, lastBarTime: (signals[0]!.lastBarTime ?? 0) + 60_000 };
    await trader.tick(); // 复核开仓 R2
    const rows = await openPositions();
    expect(rows.length).toBe(1);
    const m2 = await trendTradeRepo.getMeta(rows[0]!.id);
    expect(m2?.trendCycleId).toBe(meta.trendCycleId); // 同周期
    expect(m2?.entryRound).toBe(2); // 第二轮
  });

  test('T5 趋势确认结束（ENDED 同周期 + 证据晚于开仓）→ 平仓 TREND_ENDED；滑点/手续费/净盈亏口径正确', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:851' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const [pos] = await openPositions();
    const meta0 = await trendTradeRepo.getMeta(pos!.id);
    expect(meta0?.status).toBe('OPEN');
    const openSlip = meta0!.slippageEst;
    const openNotional = pos!.margin * 20;
    expect(openSlip).toBeCloseTo(openNotional * (TREND_TRADE.SLIPPAGE_BPS / 10_000), 9); // 名义 × 2bp

    // 价格变动后趋势确认结束（同一周期 id、新 K 线）
    engine.marks.set('BTCUSDT', 102);
    const endBar = barClock + 120_000;
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'ENDED',
      endedAt: endBar,
      endReason: 'DECAY',
      endEvidenceBars: 3,
      trendCycleId: meta0!.trendCycleId,
      lastBarTime: endBar,
    };
    await trader.tick();
    const closed = await client.paperPosition.findUnique({ where: { id: pos!.id } });
    expect(closed?.status).toBe('CLOSED');
    const meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta?.exitReason).toBe('TREND_ENDED');
    expect(meta?.exitEndReason).toBe('DECAY');
    expect(meta?.exitEvidenceBars).toBe(3);
    // netPnlWithSlip = PaperEngine 净盈亏 − 开仓滑点 − 平仓滑点
    const closeSlip = 102 * pos!.qty * (TREND_TRADE.SLIPPAGE_BPS / 10_000);
    const expectedNet = (closed!.pnl ?? 0) - openSlip - closeSlip;
    expect(meta!.netPnlWithSlip ?? 0).toBeCloseTo(expectedNet, 6);
    // 手续费双边：开仓费（名义×taker）+ 平仓费（平仓名义×taker）
    const feeSum = await client.paperTrade.aggregate({ _sum: { fee: true } });
    expect(feeSum._sum.fee ?? 0).toBeCloseTo(openNotional * TAKER_FEE + 102 * pos!.qty * TAKER_FEE, 6);
  });

  test('T6 幂等：同一趋势周期不重复开仓（CONVERTED 后不再重建待入场）；重启后（新实例）仍不重复', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:777' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    expect((await openPositions()).length).toBe(1);
    // 继续推进 K 线：CONVERTED 待入场不重建、不重复开仓
    signals[0] = nextBar(signals[0]!);
    await trader.tick();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    // 重启模拟：全新实例（同一 DB repo）
    const trader2 = makeTrader(signals, engine);
    await trader2.ensureStarted();
    await trader2.tick();
    expect((await openPositions()).length).toBe(1);
    const decisions = await trendTradeRepo.recentDecisions(10);
    expect(decisions.filter((d) => d.action === 'OPEN').length).toBe(1);
  });

  test('T7 数据过期：不开新仓、不误判趋势结束（持仓保持，不伪装 ENDED）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:888' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    // 数据不可用：新信号不开仓；持仓信号缺失也不误平
    signals.length = 0;
    signals.push(
      sig({ symbol: 'BTCUSDT', phase: 'DATA_UNAVAILABLE', direction: 'flat', cycleId: null, dataFresh: false }),
      sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', dataFresh: false }),
    );
    engine.marks.set('ETHUSDT', 50);
    await trader.tick();
    const rows = await openPositions();
    expect(rows.length).toBe(1);
    expect(rows[0]!.symbol).toBe('BTCUSDT');
    const meta = await trendTradeRepo.getMeta(rows[0]!.id);
    expect(meta?.status).toBe('OPEN');
  });

  test('T9 暂停：不开新仓（含待入场不转换）；现有持仓仍受监控（趋势结束照常离场）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:999' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    await trader.pause();
    // 新确认信号在暂停下不开仓（也不建待入场）
    signals.push(sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_DOWN', cycleId: 'ETHUSDT:S:999' }));
    await trader.tick();
    let rows = await openPositions();
    expect(rows.length).toBe(1);
    expect((await activePendings()).length).toBe(0);
    // 原持仓趋势结束 → 暂停状态下仍离场
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'ENDED',
      trendCycleId: meta.trendCycleId,
      lastBarTime: (meta.entryBarTime ?? 0) + 120_000,
    };
    await trader.tick();
    rows = await openPositions();
    expect(rows.length).toBe(0);
    const m = await trendTradeRepo.getMeta(meta.positionId);
    expect(m?.exitReason).toBe('TREND_ENDED');
    expect(await trader.mode()).toBe('PAUSED');
  });

  test('T10 重启恢复：meta 丢失时 reconcile 从决策记录还原周期关联', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:111' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const [pos] = await openPositions();
    // 模拟崩溃窗口：meta 未写 + 决策未绑定 positionId（attachPosition 之前崩溃）
    await client.$executeRawUnsafe(`DELETE FROM TrendTradeMeta WHERE positionId = ?`, pos!.id);
    await client.$executeRawUnsafe(`UPDATE TrendAutoDecision SET positionId = NULL WHERE cycleId = 'BTCUSDT:L:111'`);
    const trader2 = makeTrader(signals, engine);
    await trader2.ensureStarted(); // reconcile 修复
    const meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta).not.toBeNull();
    expect(meta!.trendCycleId).toBe('BTCUSDT:L:111'); // 从 OPEN 决策恢复
    expect(meta!.status).toBe('OPEN');
  });

  test('T11 最大持仓数：默认 3，第 4/5 个确认信号不创建待入场', async () => {
    const engine = new FakePaperEngine();
    const symbols = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((b) => `${b}USDT`);
    for (const s of symbols) engine.marks.set(s, 10);
    const signals = symbols.map((s) => sig({ symbol: s, phase: 'CONFIRMED_UP' }));
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick(); // 3 个待入场 + 2 个容量跳过
    expect((await openPositions()).length).toBe(0);
    expect((await activePendings()).length).toBe(TREND_TRADE.MAX_POSITIONS);
    expect(trader.recentSkips(10).some((s) => s.reason.includes('最大持仓数'))).toBe(true);
    for (let i = 0; i < 3; i++) signals[i] = nextBar(signals[i]!);
    await trader.tick(); // 复核开仓 3 笔
    const rows = await openPositions();
    expect(rows.length).toBe(TREND_TRADE.MAX_POSITIONS);
  });

  test('T12 强平：标记价触及强平价 → LIQUIDATED，meta 终态如实记录', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:222' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const [pos] = await openPositions();
    // 暴跌触及强平价
    engine.marks.set('BTCUSDT', pos!.liqPrice * 0.995);
    await trader.tick();
    const liq = await client.paperPosition.findUnique({ where: { id: pos!.id } });
    expect(liq?.status).toBe('LIQUIDATED');
    const meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta?.exitReason).toBe('LIQUIDATED');
    expect(meta?.netPnlWithSlip ?? 0).toBeLessThan(0);
  });

  test('T13 反向确认先平后开 + 冷却：平仓后须等冷却结束 + 新收盘 K 线才允许反向开仓', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const openBar = Date.now() - 120_000;
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:333', lastBarTime: openBar })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const [longPos] = await openPositions();
    // 反向趋势确认（新周期 S）——立即平多（htf 方向随反向更新，否则会被高周期过滤拦截）
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'CONFIRMED_DOWN',
      direction: 'down',
      trendCycleId: 'BTCUSDT:S:334',
      trendStartedAt: openBar,
      lastBarTime: Date.now(),
      htf5m: { dir: 'down', efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 96 },
      htf15m: { dir: 'down', efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 32 },
    };
    await trader.tick();
    const closed = await client.paperPosition.findUnique({ where: { id: longPos!.id } });
    expect(closed?.status).toBe('CLOSED');
    const closedMeta = await trendTradeRepo.getMeta(longPos!.id);
    expect(closedMeta?.exitReason).toBe('REVERSE_CONFIRMED');
    // 冷却期内（刚平仓 < 5min）：反向开仓被冷却拦截，不建待入场
    expect((await activePendings()).length).toBe(0);
    // 回拨平仓时刻模拟冷却结束 → 新收盘 K 线建待入场 → 再推进一根后开空
    await backdateLastClose('BTCUSDT', 6);
    await trader.tick(); // 建空单待入场
    expect((await activePendings()).length).toBe(1);
    signals[0] = nextBar(signals[0]!);
    await trader.tick(); // 复核开空
    const rows = await openPositions();
    expect(rows.length).toBe(1);
    expect(rows[0]!.side).toBe('SHORT');
  });

  test('T14 人工平仓/全部平仓：MANUAL 语义，与暂停互不影响', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:444' }),
      sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_DOWN', cycleId: 'ETHUSDT:S:444' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader, 0);
    signals[1] = nextBar(signals[1]!);
    await trader.tick();
    expect((await openPositions()).length).toBe(2);
    await trader.pause();
    const r = await trader.closeAllManual();
    expect(r.closed).toBe(2);
    expect((await openPositions()).length).toBe(0);
    const metas = await trendTradeRepo.loadMetasByStatus('CLOSED');
    expect(metas.every((m) => m.exitReason === 'MANUAL')).toBe(true);
  });

  test('T15 资金不足：权益 20% 保证金低于最小值 → 跳过并记录 SKIP（决策审计可查）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:555' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    // 掏空余额（权益 1 → 20% 保证金 0.2 < MIN_MARGIN 2）
    const acc = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    await client.paperAccount.update({ where: { id: acc!.id }, data: { balance: 1 } });
    await trader.tick(); // 建待入场
    signals[0] = nextBar(signals[0]!);
    await trader.tick(); // 复核：资金不足跳过
    expect((await openPositions()).length).toBe(0);
    const decisions = await trendTradeRepo.recentDecisions(10);
    const skip = decisions.find((d) => d.action === 'SKIP');
    expect(skip).toBeDefined();
  });

  test('T16 充值（Task 55）：机器人账户 balance/totalDeposited 同步增加，与手动盘隔离', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const trader = makeTrader([sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP' })], engine);
    await trader.ensureStarted(); // boot 建户（INITIAL_CAPITAL）
    const realEngine = new PaperEngine(TREND_TRADE.ACCOUNT_NAME);
    const before = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    expect(before!.balance).toBe(TREND_TRADE.INITIAL_CAPITAL);
    const r = await realEngine.deposit(50);
    expect(r.balance).toBe(TREND_TRADE.INITIAL_CAPITAL + 50);
    expect(r.totalDeposited).toBe(50);
    expect(await client.paperAccount.findUnique({ where: { name: 'default' } })).toBeNull();
    expect(realEngine.deposit(5)).rejects.toBeInstanceOf(PaperError);
  });

  test('T17 持仓数量可选（持久化）：仓数 ≤4 时不触顶，每仓保证金仍 = 权益 20%（Task 58 封顶不改变小仓数行为）', async () => {
    await trendTradeRepo.seedConfig({
      name: TREND_TRADE.ACCOUNT_NAME,
      mode: 'RUNNING',
      initialCapital: 100,
      marginRatio: 0.2,
      leverage: 20,
      maxPositions: 3,
      slippageBps: 2,
      peakEquity: 0,
    });
    await trendTradeRepo.updateMaxPositions(TREND_TRADE.ACCOUNT_NAME, 2);
    expect((await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME))!.maxPositions).toBe(2);

    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals: UnifiedTrendSignal[] = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:801' }),
      sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:802' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader, 0); // BTC 开仓（margin = floor2(100×0.2) = 20）
    signals[1] = nextBar(signals[1]!);
    await trader.tick(); // ETH 复核开仓（权益扣掉一笔手续费后重算 20%）
    const rows = await openPositions();
    expect(rows.length).toBe(2);
    const floor2 = (v: number) => Math.floor((v + 1e-9) * 100) / 100;
    const m1 = floor2(100 * 0.2); // 20
    const m2 = floor2((100 - m1 * 20 * TAKER_FEE) * 0.2); // 权益递减一笔开仓手续费后的 20%
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get('BTCUSDT')!.margin).toBeCloseTo(m1, 2);
    expect(bySymbol.get('ETHUSDT')!.margin).toBeCloseTo(m2, 2);
    // 两仓均为权益 20%（仓数 2 远低于 95%÷2=47.5% 封顶线，设定比例原样生效）
    expect(Math.abs(m1 - m2)).toBeLessThan(0.1);
  });

  test('T17b Task 58 仓位测算封顶：maxPositions=8 时每仓保证金 = 权益 × min(20%, 95%÷8)=11.875%（满仓可开，修复「8 仓只开出 4 仓」）', async () => {
    await trendTradeRepo.seedConfig({
      name: TREND_TRADE.ACCOUNT_NAME,
      mode: 'RUNNING',
      initialCapital: 100,
      marginRatio: 0.2,
      leverage: 20,
      maxPositions: 8,
      slippageBps: 2,
      peakEquity: 0,
    });
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals: UnifiedTrendSignal[] = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:803' }),
      sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:804' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader, 0); // BTC：margin = floor2(100 × 0.11875) = 11.87
    signals[1] = nextBar(signals[1]!);
    await trader.tick(); // ETH：权益扣掉一笔手续费后重算 11.875%
    const rows = await openPositions();
    expect(rows.length).toBe(2);
    const floor2 = (v: number) => Math.floor((v + 1e-9) * 100) / 100;
    const m1 = floor2(100 * (TREND_TRADE.MARGIN_SLOT_HEADROOM / 8)); // 11.87
    const m2 = floor2((100 - m1 * 20 * TAKER_FEE) * (TREND_TRADE.MARGIN_SLOT_HEADROOM / 8)); // ≈11.86
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get('BTCUSDT')!.margin).toBeCloseTo(m1, 2);
    expect(bySymbol.get('ETHUSDT')!.margin).toBeCloseTo(m2, 2);
    // 关键断言：封顶生效——旧 sizing 会是 20.00（8×20%=160% 权益，第 5 仓起必然跳过）
    expect(m1).toBeLessThan(12);
    // 预算自洽：8 仓理论满仓占用 ≈ 95% 权益 + 手续费 ≈ 0.95%，不超预算
    expect(m1 * 8).toBeLessThanOrEqual(100 * TREND_TRADE.MARGIN_SLOT_HEADROOM + 0.1);
  });

  test('T18 结束迹象首次报警（Task 56 语义，策略关闭提前离场）：END_PENDING 不平仓 + firstEndSignAt 持久化', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:918' })];
    const trader = makeTrader(signals, engine, new ShortSwingStrategy({ WEAKNESS_EXIT_EARLY: false }));
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    expect((await openPositions()).length).toBe(1);
    // 同周期出现结束迹象（END_PENDING = 模型报警）——不平仓，只记录首次报警时刻
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
    const since = Date.now();
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'END_PENDING',
      direction: 'up',
      endEvidenceBars: 1,
      endPendingSince: since,
      trendCycleId: meta.trendCycleId,
    };
    await trader.tick();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    const m = await trendTradeRepo.getMeta(meta.positionId);
    expect(m?.status).toBe('OPEN');
    expect(m?.firstEndSignAt ?? 0).toBeGreaterThanOrEqual(since - 1000);
  });

  test('T19 周期匹配（验收 4）：旧 trendCycleId 的 ENDED 不关闭新周期持仓', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:919' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const [pos] = await openPositions();
    expect(pos).toBeDefined();
    // 旧/他周期 ENDED：不得仅凭 symbol 平掉本周期持仓（§2.2）
    signals[0] = { ...keepSig(signals[0]!), phase: 'ENDED', trendCycleId: 'BTCUSDT:L:999-rebuilt', lastBarTime: Date.now() };
    await trader.tick();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    const m = await trendTradeRepo.getMeta(pos!.id);
    expect(m?.status).toBe('OPEN');
    // 同周期 ENDED（证据晚于开仓 bar）→ 正常离场
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'ENDED',
      trendCycleId: 'BTCUSDT:L:919',
      lastBarTime: (m?.entryBarTime ?? 0) + 120_000,
      endReason: 'DECAY',
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
  });

  test('T20 重置账户：平掉持仓并清空流水/趋势关联/决策/待入场，资金回到 100 U、ROI 基准归零', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:920' }),
      sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_DOWN', cycleId: 'ETHUSDT:S:920' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick(); // 两笔建待入场
    signals[0] = nextBar(signals[0]!);
    signals[1] = nextBar(signals[1]!);
    await trader.tick(); // 两笔复核开仓
    expect((await openPositions()).length).toBe(2);
    // 充值改变余额/totalDeposited 后重置：都应回到初始态
    await new PaperEngine(TREND_TRADE.ACCOUNT_NAME).deposit(500);
    const r = await trader.resetAccount();
    expect(r.closed).toBe(2);
    expect((await openPositions()).length).toBe(0);
    const acc = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    expect(acc!.balance).toBe(TREND_TRADE.INITIAL_CAPITAL);
    expect(acc!.totalDeposited).toBe(0); // ROI 本金基准 = initialCapital + totalDeposited = 100
    expect(await client.paperPosition.count()).toBe(0);
    expect(await client.paperTrade.count()).toBe(0);
    expect(await trendTradeRepo.loadMetasByStatus('OPEN')).toHaveLength(0);
    expect(await trendTradeRepo.loadMetasByStatus('CLOSED')).toHaveLength(0);
    expect(await trendTradeRepo.recentDecisions(10)).toHaveLength(0);
    expect(await trendTradeRepo.loadActivePendings()).toHaveLength(0);
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    expect(cfg!.peakEquity).toBe(0);
  });

  test('T21 资金不足（§六）：权益 20% 保证金 + 手续费 > 可用余额 → 跳过 + SKIP 记录（不变通）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals: UnifiedTrendSignal[] = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:921' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    expect((await openPositions()).length).toBe(1);
    // 资金滚动打穿：余额 5（已占用保证金 ≈ 19.8），权益 ≈ 24.8 → 目标 4.96 + 费 ≈ 5.06 > 余额 5
    const acc = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    await client.paperAccount.update({ where: { id: acc!.id }, data: { balance: 5 } });
    signals.push(sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:922' }));
    await trader.tick(); // 建待入场
    signals[1] = nextBar(signals[1]!);
    await trader.tick(); // 复核：目标保证金+手续费超出余额 → 跳过
    const rows = await openPositions();
    expect(rows.length).toBe(1); // 第二笔不开（不变通提高杠杆/比例）
    const decisions = await trendTradeRepo.recentDecisions(10);
    expect(decisions.some((d) => d.action === 'SKIP' && String(d.detail).includes('超出可用余额'))).toBe(true);
    // Task 57：轮次不因资金不足烧毁——pending 取消后可重建（资金恢复后同一确认趋势仍可开仓）
    const pend = await trendTradeRepo.getPendingByCycle('ETHUSDT:L:922#R1');
    expect(pend == null || pend.status === 'CANCELED' || pend.status === 'ACTIVE').toBe(true);
  });

  test('T22 开仓所在 K 线不得触发结束确认（验收 5）：ENDED 同周期但证据 bar == 开仓 bar → 不平仓', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:930' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick(); // 建待入场（firstBar = 当前 bar）
    const entryBar = signals[0]!.lastBarTime!;
    signals[0] = nextBar(signals[0]!);
    await trader.tick(); // 复核开仓（entryBarTime = 复核时的 bar）
    const [pos] = await openPositions();
    expect(pos).toBeDefined();
    const meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta?.entryBarTime).toBe(signals[0]!.lastBarTime);
    // ENDED 信号的 lastBarTime 未晚于开仓 bar（≤ entryBar）→ 不平
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'ENDED',
      trendCycleId: 'BTCUSDT:L:930',
      lastBarTime: entryBar, // 早于开仓 bar
      endReason: 'DECAY',
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    const m = await trendTradeRepo.getMeta(pos!.id);
    expect(m?.status).toBe('OPEN');
  });

  test('T23 三根独立收盘 K 线证据（Task 56 语义，策略关闭提前离场）：期间持仓保持，lifecycle 判定 ENDED 后才离场', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:931' })];
    const trader = makeTrader(signals, engine, new ShortSwingStrategy({ WEAKNESS_EXIT_EARLY: false }));
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
    // 证据 1/3、2/3：END_PENDING 持仓保持
    for (const bars of [1, 2]) {
      signals[0] = {
        ...keepSig(signals[0]!),
        phase: 'END_PENDING',
        direction: 'up',
        endEvidenceBars: bars,
        endPendingSince: Date.now(),
        trendCycleId: meta.trendCycleId,
        lastBarTime: (signals[0]!.lastBarTime ?? 0) + 60_000,
      };
      await trader.tick();
      expect((await openPositions()).length).toBe(1);
    }
    // 证据 3/3 → lifecycle ENDED（同周期 + 新 K 线）→ 离场
    const endBar = (signals[0]!.lastBarTime ?? 0) + 60_000;
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'ENDED',
      endedAt: endBar,
      endReason: 'DECAY',
      endEvidenceBars: 3,
      trendCycleId: meta.trendCycleId,
      lastBarTime: endBar,
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    const m = await trendTradeRepo.getMeta(meta.positionId);
    expect(m?.exitReason).toBe('TREND_ENDED');
    expect(m?.firstEndSignAt ?? 0).toBeGreaterThan(0);
  });

  test('T24 结束迹象恢复（迟滞重置，Task 56 语义，策略关闭提前离场）：END_PENDING → 恢复 CONFIRMED → 再 END_PENDING，持仓保持', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:932' })];
    const trader = makeTrader(signals, engine, new ShortSwingStrategy({ WEAKNESS_EXIT_EARLY: false }));
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
    // 证据 1 根
    signals[0] = {
      ...keepSig(signals[0]!), phase: 'END_PENDING', direction: 'up', endEvidenceBars: 1,
      endPendingSince: Date.now(), trendCycleId: meta.trendCycleId,
      lastBarTime: (signals[0]!.lastBarTime ?? 0) + 60_000,
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    // 条件恢复 → CONFIRMED（lifecycle 清零重计）
    signals[0] = { ...keepSig(signals[0]!), phase: 'CONFIRMED_UP', direction: 'up', endEvidenceBars: 0, endPendingSince: null };
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    // 再次出现证据 1 根 → 仍是 END_PENDING（重新计数），不平仓
    signals[0] = {
      ...keepSig(signals[0]!), phase: 'END_PENDING', direction: 'up', endEvidenceBars: 1,
      endPendingSince: Date.now(), trendCycleId: meta.trendCycleId,
      lastBarTime: (signals[0]!.lastBarTime ?? 0) + 120_000,
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
  });

  test('T25 入场门槛（验收 11）：低评分 / 低 ER 的确认趋势不开仓', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const trader = makeTrader(
      [
        sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:940', score: 40 }), // < 45（短周期套利趋势起点门槛）
        sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:941', er: 0.3 }), // < 0.35
      ],
      engine,
    );
    await trader.ensureStarted();
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    expect((await activePendings()).length).toBe(0);
    const skips = trader.recentSkips(10);
    expect(skips.some((s) => s.reason.includes('评分'))).toBe(true);
    expect(skips.some((s) => s.reason.includes('ER'))).toBe(true);
  });

  test('T26 策略门槛（Task 57/57-b 语义）：5m 反对拒绝；5m 震荡/数据不足 = 震荡选向严门槛（score≥55+ER≥0.45）', async () => {
    const engine = new FakePaperEngine();
    for (const [s, p] of [['AAAUSDT', 10], ['BBBUSDT', 10], ['CCCUSDT', 10], ['DDDUSDT', 10]] as const) {
      engine.marks.set(s, p);
    }
    const trader = makeTrader(
      [
        // 5m 反对 → 拒绝（短周期套利不做逆势）
        sig({ symbol: 'AAAUSDT', phase: 'CONFIRMED_UP', cycleId: 'AAAUSDT:L:950', htf5mDir: 'down' }),
        // 5m 数据不足（视同震荡）+ score 80/ER 0.5（默认）→ 严门槛通过（震荡选向）
        sig({ symbol: 'BBBUSDT', phase: 'CONFIRMED_UP', cycleId: 'BBBUSDT:L:951', htf5mValid: false }),
        // 5m 中性 + score 50（< 55 严一档）→ 拒绝
        sig({ symbol: 'CCCUSDT', phase: 'CONFIRMED_UP', cycleId: 'CCCUSDT:L:952', htf5mDir: 'flat', score: 50 }),
        // 5m 中性 + score 88 / ER 0.55（≥ 严门槛）→ 创建待入场
        sig({ symbol: 'DDDUSDT', phase: 'CONFIRMED_UP', cycleId: 'DDDUSDT:L:953', htf5mDir: 'flat', score: 88, er: 0.55 }),
      ],
      engine,
    );
    await trader.ensureStarted();
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    const pendings = await activePendings();
    expect(pendings.length).toBe(2);
    expect(pendings.map((p) => p.symbol).sort()).toEqual(['BBBUSDT', 'DDDUSDT']);
    const skips = trader.recentSkips(10);
    expect(skips.some((s) => s.reason.includes('相反'))).toBe(true); // 5m 反对
    expect(skips.some((s) => s.reason.includes('更严证据'))).toBe(true); // 震荡选向门槛不足
  });

  test('T27 待入场二次确认（验收 13）：首 tick 只建记录 → 新收盘 K 线复核 → 只开一次；趋势失效取消', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:960' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick(); // 首次确认：只建待入场，不下单
    expect((await openPositions()).length).toBe(0);
    expect((await activePendings()).length).toBe(1);
    expect((await activePendings())[0]!.cycleId).toBe('BTCUSDT:L:960#R1');
    // 同一根 K 线重复扫描：不转换（等待新的已收盘 K 线）
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    // 新收盘 K 线 + 条件仍满足 → 开仓（每周期仅一次）
    signals[0] = nextBar(signals[0]!);
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    expect((await activePendings()).length).toBe(0);
    // 趋势结束离场后：同币种冷却期内，新周期确认不建待入场；冷却结束后才建
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'ENDED',
      trendCycleId: 'BTCUSDT:L:960',
      lastBarTime: (signals[0]!.lastBarTime ?? 0) + 120_000,
      endReason: 'DECAY',
    };
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    signals[0] = sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:961' });
    await trader.tick(); // 冷却期内：不建待入场
    expect((await activePendings()).length).toBe(0);
    expect(trader.recentSkips(5).some((s) => s.reason.includes('冷却'))).toBe(true);
    await backdateLastClose('BTCUSDT', 6); // 模拟冷却结束
    await trader.tick(); // 建新周期待入场
    expect((await activePendings()).length).toBe(1);
    expect((await activePendings())[0]!.cycleId).toBe('BTCUSDT:L:961#R1');
  });

  test('T28 MFE/MAE 增量更新（验收 18）：按可用标记价维护峰值，MFE 回撤幅度同步', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:970' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader);
    const [pos] = await openPositions();
    // 首次统计（价格未变）：浮盈 = -开仓手续费（占保证金）
    await trader.tick();
    let meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta?.mfe).toBeDefined();
    expect(meta?.mae).toBeDefined();
    // 价格上行 10% → 20x 杠杆浮盈 ≈ +200% 保证金
    engine.marks.set('BTCUSDT', 110);
    await trader.tick();
    meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta!.mfe ?? 0).toBeCloseTo(((110 - 100) * pos!.qty * 1 * 100) / pos!.margin, 1);
    expect(meta!.mfeAt ?? 0).toBeGreaterThan(0);
    // 价格回落（避开强平线 ~95）→ MAE 记录更大浮亏，MFE 保持峰值，回撤幅度 = mfe - 当前
    engine.marks.set('BTCUSDT', 98);
    await trader.tick();
    meta = await trendTradeRepo.getMeta(pos!.id);
    const curPnlPct = ((98 - 100) * pos!.qty * 100) / pos!.margin;
    expect(meta!.mae ?? 0).toBeCloseTo(curPnlPct, 6);
    expect(meta!.mfe ?? 0).toBeCloseTo(((110 - 100) * pos!.qty * 1 * 100) / pos!.margin, 1);
    expect(meta!.mfeDrawdown ?? 0).toBeCloseTo((meta!.mfe ?? 0) - curPnlPct, 1);
  });

  // ===== Task 57-c：参数控制台 =====

  test('T29a effectiveMarginRatio 封顶表（Task 58）：仓数多时自动压缩，小仓数/低设定值原样生效', () => {
    // ≤4 仓：20% 不触顶（与 Task 54 定版一致）
    expect(effectiveMarginRatio(0.2, 1)).toBe(0.2);
    expect(effectiveMarginRatio(0.2, 4)).toBe(0.2);
    // 5/6/8 仓：95%÷仓数封顶
    expect(effectiveMarginRatio(0.2, 5)).toBeCloseTo(0.19, 10);
    expect(effectiveMarginRatio(0.2, 6)).toBeCloseTo(0.95 / 6, 10);
    expect(effectiveMarginRatio(0.2, 8)).toBeCloseTo(0.11875, 10);
    // 设定值低于封顶线：用户值原样生效
    expect(effectiveMarginRatio(0.05, 8)).toBe(0.05);
    // 高设定值同样被封顶（3 仓 × 50% = 150% 也不可能）
    expect(effectiveMarginRatio(0.5, 3)).toBeCloseTo(0.95 / 3, 10);
    // 退化入防：非法仓数回原值
    expect(effectiveMarginRatio(0.2, 0)).toBe(0.2);
  });

  test('T29 参数校验：未知键/超范围/类型错误拒绝；合法值通过（严格写路径）', () => {
    expect(() => sanitizeRuntimeParams({ NOPE: 1 })).toThrow(/未知参数/);
    expect(() => sanitizeRuntimeParams({ ENTRY_MIN_SCORE: 200 })).toThrow(/不能超过/);
    expect(() => sanitizeRuntimeParams({ waitBarConfirm: 'yes' })).toThrow(/true\/false/);
    expect(() => sanitizeRuntimeParams({ ENTRY_MIN_ER: -1 })).toThrow(/不能低于/);
    const ok = sanitizeRuntimeParams({
      ENTRY_MIN_SCORE: 50,
      ENTRY_MIN_ER: 0.3,
      waitBarConfirm: false,
      cooldownMs: 60_000,
    });
    expect(ok.strategyParams.ENTRY_MIN_SCORE).toBe(50);
    expect(ok.strategyParams.ENTRY_MIN_ER).toBe(0.3);
    expect(ok.waitBarConfirm).toBe(0);
    expect(ok.cooldownMs).toBe(60_000);
  });

  test('T30 控制台调参热生效：ENTRY_MIN_SCORE 45→50 持久化 + 新信号按新门槛评估（轮次状态保留）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    // 40 分 < 默认门槛 45：拒绝且不建待入场（后续调参不被旧待入场挡路）
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:980', score: 40 })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    expect((await activePendings()).length).toBe(0);
    expect(trader.recentSkips(5).some((s) => s.reason.includes('评分 40 < 45'))).toBe(true);
    // 控制台把模式 A 评分门槛调到 50
    await trader.setRuntimeParams({ strategyParams: { ENTRY_MIN_SCORE: 50 } });
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    expect(JSON.parse(cfg!.strategyParamsJson ?? '{}')).toEqual({ 'short-swing-v1': { ENTRY_MIN_SCORE: 50 } });
    // 新周期 47 分：按新门槛 50 拒绝（热生效，无需重启）
    signals[0] = sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:981', score: 47 });
    await trader.tick();
    expect(trader.recentSkips(5).some((s) => s.reason.includes('评分 47 < 50'))).toBe(true);
    expect((await activePendings()).length).toBe(0);
    // 50 分：新门槛通过
    signals[0] = sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:982', score: 50 });
    await trader.tick();
    expect((await activePendings()).map((p) => p.cycleId)).toContain('BTCUSDT:L:982#R1');
  });

  test('T31 waitBarConfirm=0 直开路径：达标当根直接开仓（不建待入场；幂等/轮次/meta 全同构）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:990' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.setRuntimeParams({ waitBarConfirm: 0 });
    expect((await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME))?.waitBarConfirm).toBe(0);
    await trader.tick(); // 直接开仓（无待入场等待）
    const positions = await openPositions();
    expect(positions.length).toBe(1);
    expect((await activePendings()).length).toBe(0);
    const meta = await trendTradeRepo.getMeta(positions[0]!.id);
    expect(meta?.status).toBe('OPEN');
    expect(meta?.entryRound).toBe(1);
    // 决策幂等键与 pending 路径同构
    const decisions = await client.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM TrendAutoDecision WHERE id = 'BTCUSDT:L:990#R1:OPEN'`,
    );
    expect(decisions.length).toBe(1);
    // 同周期同根 K 线重复扫描：不再开（幂等）
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
  });

  test('T32 cooldownMs 可调：0 冷却下平仓后同 tick 可再入场（默认 5 分钟不受影响见 T13）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:995' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.setRuntimeParams({ cooldownMs: 0 });
    await openViaPending(signals, trader);
    expect((await openPositions()).length).toBe(1);
    // 平仓 → 冷却 0：新周期信号立即允许建待入场
    const [pos] = await openPositions();
    await trader.closeOne(pos!.id);
    signals[0] = sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:996' });
    await trader.tick();
    expect((await activePendings()).map((p) => p.cycleId)).toContain('BTCUSDT:L:996#R1');
  });

  test('T33 恢复默认：清参数覆盖 + 二次确认回开 + 冷却回默认（轮次状态保留）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:999', score: 47 })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.setRuntimeParams({
      strategyParams: { ENTRY_MIN_SCORE: 50, SPIKE_MOVE_PCT: 0.8 },
      waitBarConfirm: 0,
      cooldownMs: 0,
    });
    await trader.resetRuntimeParams();
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    expect(cfg?.strategyParamsJson).toBe('{}');
    expect(cfg?.waitBarConfirm).toBe(1);
    expect(cfg?.cooldownMs ?? null).toBeNull();
    // 行为回默认：47 分重新可达门槛 45（建待入场），且走 pending 路径（不直接开仓）
    signals[0] = sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:1000', score: 47 });
    await trader.tick();
    expect((await activePendings()).length).toBe(1);
    expect((await openPositions()).length).toBe(0);
  });

  test('T34 marginRatio 控制台参数（Task 58）：严格校验 + 持久化 + sizing 热生效 + 恢复默认', async () => {
    // 严格写路径：范围拒绝（0.005 < 0.01；1.5 > 1），合法值通过
    expect(() => sanitizeRuntimeParams({ marginRatio: 0.005 })).toThrow(/不能低于/);
    expect(() => sanitizeRuntimeParams({ marginRatio: 1.5 })).toThrow(/不能超过/);
    expect(sanitizeRuntimeParams({ marginRatio: 0.35 }).marginRatio).toBe(0.35);
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:1005' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    // 控制台调到 10%：持久化到 marginRatio 列（infra 域，下一 tick 生效）
    await trader.setRuntimeParams({ marginRatio: 0.1 });
    expect((await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME))?.marginRatio).toBe(0.1);
    // sizing 生效：默认 3 仓不触顶 → margin = floor2(100 × 0.1) = 10.00（旧默认 0.2 会是 20.00）
    await openViaPending(signals, trader);
    const [pos] = await openPositions();
    expect(pos!.margin).toBeCloseTo(10, 2);
    // 恢复默认：marginRatio 回 0.2（列 NOT NULL，回代码默认值而非 null）
    await trader.resetRuntimeParams();
    expect((await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME))?.marginRatio).toBe(0.2);
  });
});
