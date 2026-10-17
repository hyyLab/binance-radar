// 调试 T19：ENDED 同周期为何未平仓
import { execSync } from 'node:child_process';
execSync('bunx prisma db push --skip-generate --accept-data-loss', {
  env: { ...process.env, DATABASE_URL: 'file:/home/z/my-project/db/trend-debug.db' },
  cwd: '/home/z/my-project',
  stdio: 'pipe',
});
const { AutoPaperTrader } = await import('@/lib/market/trend-trade/auto-trader');
const { trendTradeRepo } = await import('@/lib/market/trend-trade/repo');
const { TREND_TRADE } = await import('@/lib/market/trend-trade/config');
import { db as client } from '@/lib/db';

let barClock = Date.now() - 300_000;
function sig(partial: Record<string, unknown>): any {
  barClock += 60_000;
  const phase = partial.phase as string;
  const dir = partial.direction ?? (phase === 'CONFIRMED_UP' ? 'up' : phase === 'CONFIRMED_DOWN' ? 'down' : 'flat');
  const cycleDir = phase === 'CONFIRMED_UP' ? 'L' : phase === 'CONFIRMED_DOWN' ? 'S' : 'X';
  return {
    symbol: partial.symbol, market: 'futures', interval: '1m',
    phase, direction: dir,
    trendCycleId: partial.cycleId !== undefined ? partial.cycleId : `${partial.symbol}:${cycleDir}:${barClock}`,
    trendStartedAt: phase.startsWith('CONFIRMED') ? barClock : null,
    endPendingSince: null, endEvidenceBars: 0,
    endedAt: phase === 'ENDED' ? barClock : null,
    endReason: phase === 'ENDED' ? 'DECAY' : null,
    score: (partial.score as number) ?? 80, strength: 0.6, confirmCount: 3,
    features: { atr: 1, atrPct: 1.2, realizedVolPct: 40, volPercentile: 0.7, volRegime: 'HIGH', efficiencyRatio: 0.5, upperWickPct: 0.1, lowerWickPct: 0.1, breakout: 'none', falseBreakout: false, barsUsed: 480 },
    htf5m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 96 },
    htf15m: { dir, efficiencyRatio: 0.5, returnPct: 1, valid: true, bars: 32 },
    htfAgree: true,
    lastBarTime: (partial.lastBarTime as number) ?? barClock,
    lastKlineAt: barClock,
    dataFresh: (partial.dataFresh as boolean) ?? true,
    dataUnavailableReason: null,
    anomaly: { dir: null, level: null, priority: null, active: false, lastAt: null },
    conflict: false, reason: '测试信号', changedAt: barClock,
  };
}

async function main() {
  await client.$executeRawUnsafe(`DELETE FROM PaperTrade`);
  await client.$executeRawUnsafe(`DELETE FROM PaperPosition`);
  await client.$executeRawUnsafe(`DELETE FROM PaperAccount`);
  await client.$executeRawUnsafe(`DELETE FROM TrendAutoConfig`);
  await client.$executeRawUnsafe(`DELETE FROM TrendTradeMeta`);
  await client.$executeRawUnsafe(`DELETE FROM TrendAutoDecision`);
  await client.$executeRawUnsafe(`DELETE FROM TrendPendingEntry`);

  const marks = new Map([['BTCUSDT', 100]]);
  const signals: any[] = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:919' })];
  const trader = new AutoPaperTrader(
    { getSignals: () => signals, markPrice: (s) => marks.get(s) ?? 0 },
    { noTimer: true },
  );
  await trader.ensureStarted();
  await trader.tick();
  signals[0] = { ...signals[0], lastBarTime: (signals[0].lastBarTime ?? 0) + 60_000 };
  await trader.tick();
  const [pos] = await client.paperPosition.findMany({ where: { status: 'OPEN' } });
  console.log('opened:', pos?.id, pos?.margin);
  const meta = await trendTradeRepo.getMeta(pos!.id);
  console.log('meta.cycle:', meta?.trendCycleId, 'entryBar:', meta?.entryBarTime, 'status:', meta?.status);

  // ENDED 同周期
  signals[0] = {
    ...signals[0],
    phase: 'ENDED',
    trendCycleId: 'BTCUSDT:L:919',
    lastBarTime: Date.now() + 120_000,
    endReason: 'DECAY',
  };
  console.log('signal lastBar:', signals[0].lastBarTime, 'entryBar:', meta?.entryBarTime, 'greater:', signals[0].lastBarTime > (meta?.entryBarTime ?? 0));
  await trader.tick();
  const after = await client.paperPosition.findUnique({ where: { id: pos!.id } });
  console.log('after tick status:', after?.status);
  const metaAfter = await trendTradeRepo.getMeta(pos!.id);
  console.log('meta after:', metaAfter?.status, metaAfter?.exitReason);
  await client.$disconnect();
}
main();
