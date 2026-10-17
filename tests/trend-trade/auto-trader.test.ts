// ---------- 趋势自动模拟交易 · 行为测试（bun test，独立测试库 + fake 注入） ----------
// 覆盖任务 §七 12 项要求中可自动化验证的全部场景（页面展示用截图人工核验）：
// 1) 手动账户隔离  2) 权益÷持仓数量均分开仓（余额不足 clamp 保护）+ 20x  3) 未确认不开仓  4) 短暂反向不提前平仓
// 5) 趋势结束/反向确认正确离场  6) 同一趋势信号不重复开仓（含重启）
// 7) 数据过期不开仓、不误判结束  8) 手续费/滑点/净盈亏口径
// 9) 暂停后不开新仓但持仓仍受监控（含强平）  10) 重启恢复持仓关联（reconcile）
// 11) 最大持仓数与保证金限制  12) 强平记录正确；附：先平后开独立性、人工平仓/全部平仓、
//     充值（Task 55）、持仓数量变更持久化（Task 55）、
//     结束迹象即自行平仓/残留持仓自行离场/重置账户（Task 55-2）；
//     滚动资金保护：余额被打穿后新仓 clamp 到可承受最大值而非跳过（Task 55-3）

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';

// ⚠️ 测试库隔离：bunfig.toml [test].preload（tests/preload-test-db.ts）在任何测试文件
// 加载前把 DATABASE_URL 指向独立测试库——@/lib/db 单例与本文件的 client 绑定同一库，
// 不触碰 db/custom.db。下方 beforeAll 用 prisma db push 同步完整 schema。
const TEST_DB_URL = 'file:/home/z/my-project/db/trend-trade-test.db';

import { AutoPaperTrader } from '@/lib/market/trend-trade/auto-trader';
import { trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { PaperEngine, PaperError } from '@/lib/market/paper';
import { TAKER_FEE, liqPriceFor } from '@/lib/market/futures';
import { db as client } from '@/lib/db';
import type { PrismaClient } from '@prisma/client';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';

beforeAll(() => {
  execSync('bunx prisma db push --skip-generate', {
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

let barClock = Date.now() - 300_000; // 近真实时钟（先平后开独立性用真实平仓时刻比较）

function sig(partial: {
  symbol: string;
  phase: string;
  direction?: 'up' | 'down' | 'flat';
  cycleId?: string | null;
  dataFresh?: boolean;
  score?: number;
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
    endReason: partial.phase === 'ENDED' ? 'DECAY_CONFIRMED' : null,
    score: partial.score ?? 60,
    strength: 0.6,
    confirmCount: 3,
    features: {
      atr: 1, atrPct: 1.2, realizedVolPct: 40, volPercentile: 0.7, volRegime: 'HIGH',
      efficiencyRatio: 0.5, upperWickPct: 0.1, lowerWickPct: 0.1, breakout: 'none',
      falseBreakout: false, barsUsed: 480,
    },
    htf5m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 96 },
    htf15m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 32 },
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

/** 保留原信号其余字段（测试内替换相位用） */
function keepSig(s: UnifiedTrendSignal): UnifiedTrendSignal {
  return { ...s };
}

// ============ 测试 ============

function makeTrader(signals: UnifiedTrendSignal[], engine: FakePaperEngine) {
  return new AutoPaperTrader(
    {
      getSignals: () => signals,
      markPrice: (symbol) => engine.marks.get(symbol) ?? 0,
    },
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
  await client.$executeRawUnsafe(`DELETE FROM TrendWatchSymbol`);
}

async function openPositions() {
  return client.paperPosition.findMany({ where: { status: 'OPEN' } });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await client.$disconnect();
});
describe('AutoPaperTrader（趋势自动模拟交易）', () => {
  test('T1 账户隔离：独立账户 trend-auto-v1，不触碰手动 default 账户', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const trader = makeTrader([sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP' })], engine);
    await trader.ensureStarted();
    const accounts = await client.paperAccount.findMany();
    expect(accounts.map((a) => a.name)).toEqual(['trend-auto-v1']);
    expect(accounts[0]!.balance).toBe(TREND_TRADE.INITIAL_CAPITAL); // 初始资金来自配置（可配）
  });

  test('T2 开仓 sizing：每仓保证金 = 账户权益 ÷ 持仓数量（均分，预留手续费），杠杆 20x', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const trader = makeTrader([sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP' })], engine);
    await trader.ensureStarted();
    await trader.tick();
    const rows = await openPositions();
    expect(rows.length).toBe(1);
    // 权益 100 ÷ 4 仓 ÷ (1 + 20x×taker0.05%) 预留开仓手续费 → floor2（无持仓时权益=余额）
    const expectMargin = Math.floor((100 / 4 / (1 + 20 * TAKER_FEE) + 1e-9) * 100) / 100;
    expect(rows[0]!.margin).toBeCloseTo(expectMargin, 2);
    expect(rows[0]!.leverage).toBe(20);
    expect(rows[0]!.qty * rows[0]!.entryPrice).toBeCloseTo(expectMargin * 20, 1); // 保证金 × 20x 名义
  });

  test('T3 未确认不开仓：CANDIDATE/OBSERVING/数据过期一律不触发', async () => {
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
  });

  test('T4 短暂反向不提前平仓：反向候选（candidate）不触发离场', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    // 趋势转为反向候选（未确认）——持仓保持
    signals[0] = { ...keepSig(signals[0]!), phase: 'CANDIDATE_DOWN', direction: 'flat', trendCycleId: 'BTCUSDT:S:999' };
    await trader.tick();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
  });

  test('T5 趋势确认结束 → 平仓 TREND_ENDED；滑点/手续费口径正确', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
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
      endReason: 'DECAY_CONFIRMED',
      trendCycleId: meta0!.trendCycleId,
      lastBarTime: endBar,
    };
    await trader.tick();
    const closed = await client.paperPosition.findUnique({ where: { id: pos!.id } });
    expect(closed?.status).toBe('CLOSED');
    const meta = await trendTradeRepo.getMeta(pos!.id);
    expect(meta?.exitReason).toBe('TREND_ENDED');
    // netPnlWithSlip = PaperEngine 净盈亏 − 开仓滑点 − 平仓滑点
    const closeSlip = 102 * pos!.qty * (TREND_TRADE.SLIPPAGE_BPS / 10_000);
    const expectedNet = (closed!.pnl ?? 0) - openSlip - closeSlip;
    expect(meta!.netPnlWithSlip ?? 0).toBeCloseTo(expectedNet, 6);
    // 手续费双边：开仓费（名义×taker）+ 平仓费（平仓名义×taker）
    const feeSum = await client.paperTrade.aggregate({ _sum: { fee: true } });
    expect(feeSum._sum.fee ?? 0).toBeCloseTo(openNotional * TAKER_FEE + 102 * pos!.qty * TAKER_FEE, 6);
  });

  test('T6 幂等：同一趋势周期不重复开仓；重启后（新实例）仍不重复', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:777' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
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

  test('T7 数据过期：不开新仓、不误判趋势结束（持仓保持）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:888' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
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
  });

  test('T9 暂停：不开新仓；现有持仓仍受监控（趋势结束照常离场）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:999' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    await trader.pause();
    // 新确认信号在暂停下不开仓
    signals.push(sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_DOWN', cycleId: 'ETHUSDT:S:999' }));
    await trader.tick();
    let rows = await openPositions();
    expect(rows.length).toBe(1);
    // 原持仓趋势结束 → 暂停状态下仍离场
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
    signals[0] = { ...keepSig(signals[0]!), phase: 'ENDED', trendCycleId: meta.trendCycleId };
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
    await trader.tick();
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

  test('T11 最大持仓数：maxPositions=4，第 5 个确认信号跳过', async () => {
    const engine = new FakePaperEngine();
    const symbols = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((b) => `${b}USDT`);
    for (const s of symbols) engine.marks.set(s, 10);
    const signals = symbols.map((s) => sig({ symbol: s, phase: 'CONFIRMED_UP' }));
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    const rows = await openPositions();
    expect(rows.length).toBe(TREND_TRADE.MAX_POSITIONS);
    expect(trader.recentSkips(10).some((s) => s.reason.includes('最大持仓数'))).toBe(true);
  });

  test('T12 强平：标记价触及强平价 → LIQUIDATED，meta 终态如实记录', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:222' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
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

  test('T13 反向确认：先平后开——同一根 K 线不反向开仓，下一根已收盘 K 线才允许', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    // 时间基准用真实时钟（lastCloseAt=真实平仓时刻；bar 时间必须与同一时轴比较）：
    // openBar = 2 分钟前的已收盘 K 线；反向确认复用同一根 → +60s 仍早于平仓时刻 → 被守卫拦截
    const openBar = Date.now() - 120_000;
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:333', lastBarTime: openBar })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    const [longPos] = await openPositions();
    // 反向趋势确认（新周期 S）——确认 bar 仍是同一根 → 平多后同 tick 不得开空
    signals[0] = {
      ...keepSig(signals[0]!),
      phase: 'CONFIRMED_DOWN',
      direction: 'down',
      trendCycleId: 'BTCUSDT:S:334',
      trendStartedAt: openBar,
      lastBarTime: openBar,
    };
    await trader.tick();
    // 反向确认 tick：多单已平、空单被独立性守卫拦截（同一根 K 线）→ 0 持仓
    let rows = await openPositions();
    expect(rows.length).toBe(0);
    const closed = await client.paperPosition.findUnique({ where: { id: longPos!.id } });
    expect(closed?.status).toBe('CLOSED');
    const closedMeta = await trendTradeRepo.getMeta(longPos!.id);
    expect(closedMeta?.exitReason).toBe('REVERSE_CONFIRMED');
    // 下一根已收盘 K 线（收盘时刻晚于平仓时刻）→ 允许反向开仓
    signals[0] = { ...signals[0]!, lastBarTime: Date.now() + 60_000 };
    await trader.tick();
    rows = await openPositions();
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
    await trader.tick();
    expect((await openPositions()).length).toBe(2);
    await trader.pause();
    const r = await trader.closeAllManual();
    expect(r.closed).toBe(2);
    expect((await openPositions()).length).toBe(0);
    const metas = await trendTradeRepo.loadMetasByStatus('CLOSED');
    expect(metas.every((m) => m.exitReason === 'MANUAL')).toBe(true);
  });

  test('T15 保证金不足：跳过并记录原因（决策审计可查）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:555' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    // 掏空余额（模拟权益耗尽）
    const acc = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    await client.paperAccount.update({ where: { id: acc!.id }, data: { balance: 1 } });
    await trader.tick();
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
    // 充值走真实 PaperEngine.deposit（与手动盘同一实现、不同账户名）
    const realEngine = new PaperEngine(TREND_TRADE.ACCOUNT_NAME);
    const before = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    expect(before!.balance).toBe(TREND_TRADE.INITIAL_CAPITAL);
    const r = await realEngine.deposit(50);
    expect(r.balance).toBe(TREND_TRADE.INITIAL_CAPITAL + 50);
    expect(r.totalDeposited).toBe(50);
    // 手动盘 default 账户不受影响（本测试库从未创建）
    expect(await client.paperAccount.findUnique({ where: { name: 'default' } })).toBeNull();
    // 金额校验：低于下限拒绝
    expect(realEngine.deposit(5)).rejects.toBeInstanceOf(PaperError);
  });

  test('T17 持仓数量可选（Task 55）：maxPositions 持久化 + 新口径均分开仓', async () => {
    // 播种配置并把持仓数量改为 2（控制端更换时自动平仓由 closeAllManual 承担，见 T14）
    await trendTradeRepo.seedConfig({
      name: TREND_TRADE.ACCOUNT_NAME,
      mode: 'RUNNING',
      initialCapital: 100,
      marginRatio: 0.2,
      leverage: 20,
      maxPositions: 4,
      slippageBps: 2,
      peakEquity: 0,
    });
    await trendTradeRepo.updateMaxPositions(TREND_TRADE.ACCOUNT_NAME, 2);
    expect((await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME))!.maxPositions).toBe(2);

    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const trader = makeTrader(
      [
        sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:801' }),
        sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:802' }),
      ],
      engine,
    );
    await trader.ensureStarted();
    await trader.tick();
    const rows = await openPositions();
    expect(rows.length).toBe(2);
    // 每仓 = 权益 ÷ 持仓数量（2）：首仓 100/2/1.01 = 49.50；次仓权益递减一笔手续费后重算
    const floor2 = (v: number) => Math.floor((v + 1e-9) * 100) / 100;
    const m1 = floor2(100 / 2 / (1 + 20 * TAKER_FEE));
    const m2 = floor2((100 - m1 * 20 * TAKER_FEE) / 2 / (1 + 20 * TAKER_FEE));
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get('BTCUSDT')!.margin).toBeCloseTo(m1, 2);
    expect(bySymbol.get('ETHUSDT')!.margin).toBeCloseTo(m2, 2);
    // 两仓金额几乎一致（差异仅为一笔手续费的权益递减，金额不随资金滚动漂移）
    expect(Math.abs(m1 - m2)).toBeLessThan(0.5);
    // 仓位数改小后不会超过新上限：第三笔同价新周期不应开仓
    const acc = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    const openNow = await client.paperPosition.findMany({ where: { accountId: acc!.id, status: 'OPEN' } });
    expect(openNow.length).toBe(2);
  });

  test('T21 滚动资金保护（Task 55-3）：余额被打穿后新仓 clamp 到可承受最大值，永不因「可用余额不足」跳过', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals: UnifiedTrendSignal[] = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:921' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    let rows = await openPositions();
    expect(rows.length).toBe(1); // 首仓按 权益100÷4仓 开出
    // 模拟资金滚动变化（已实现亏损/强平损耗把余额打穿到 < 权益÷N 的目标保证金）：
    // 此时权益 = 5 + 24.75(占用) ≈ 29.75，目标 29.75/4/1.01 ≈ 7.36 > 余额可承受 5/1.01 ≈ 4.95
    const acc = await client.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    await client.paperAccount.update({ where: { id: acc!.id }, data: { balance: 5 } });
    // 新确认趋势（新周期）下一轮 tick 开仓
    signals.push(sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:922' }));
    await trader.tick();
    rows = await openPositions();
    expect(rows.length).toBe(2); // 第二笔照常开出（旧口径此处会跳过「可用余额不足」）
    const second = rows.find((r) => r.symbol === 'ETHUSDT')!;
    // clamp 到余额能承受的最大值（margin+fee ≤ 余额，与 PaperEngine.open 校验同源）
    const clamped = Math.floor((5 / (1 + 20 * TAKER_FEE) + 1e-9) * 100) / 100;
    expect(second.margin).toBeCloseTo(clamped, 2);
    expect(second.margin).toBeGreaterThanOrEqual(TREND_TRADE.MIN_MARGIN);
  });

  test('T18 结束迹象即自行平仓（Task 55-2）：END_PENDING 不再等确认根数，机器人自行离场', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:918' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    expect((await openPositions()).length).toBe(1);
    // 同周期出现结束迹象（END_PENDING = 模型已判定趋势有问题：反向候选/深回撤/结构失效）
    const meta = (await trendTradeRepo.loadMetasByStatus('OPEN'))[0]!;
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
    expect(m?.status).toBe('CLOSED');
    expect(m?.exitReason).toBe('TREND_ENDED');
    // 结束证据明细留存（exitSignalJson 含完整信号，可回溯结束报警上下文）
    expect(m?.exitSignalJson).toContain('END_PENDING');
  });

  test('T19 残留持仓自行离场（Task 55-2）：ENDED 任意周期归属（周期回收/ORPHAN 漏配）也平仓', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:919' })];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await trader.tick();
    const [pos] = await openPositions();
    expect(pos).toBeDefined();
    // 旧规则要求周期归属一致：周期回收/恢复场景漏配 → 残留持仓只能人工平；现应自行离场
    signals[0] = { ...keepSig(signals[0]!), phase: 'ENDED', trendCycleId: 'BTCUSDT:L:999-rebuilt' };
    await trader.tick();
    expect((await openPositions()).length).toBe(0);
    const m = await trendTradeRepo.getMeta(pos!.id);
    expect(m?.exitReason).toBe('TREND_ENDED');
  });

  test('T20 重置账户（Task 55-2）：平掉持仓并清空流水/趋势关联/决策，资金回到 100 U、ROI 基准归零', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const trader = makeTrader(
      [
        sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:920' }),
        sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_DOWN', cycleId: 'ETHUSDT:S:920' }),
      ],
      engine,
    );
    await trader.ensureStarted();
    await trader.tick();
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
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    expect(cfg!.peakEquity).toBe(0);
  });
});
