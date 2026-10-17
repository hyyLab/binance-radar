import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { ensureTrendTradeSchema, trendTradeRepo } from '@/lib/market/trend-trade/repo';
import { TREND_TRADE } from '@/lib/market/trend-trade/config';
import { listStrategies } from '@/lib/market/trend-trade/strategy/registry';
import {
  effectiveRuntimeParams,
  parseStrategyParamsMap,
} from '@/lib/market/trend-trade/console-params';
import type { UnifiedTrendSignal } from '@/lib/market/trend-watch/signal';

export const dynamic = 'force-dynamic';

/**
 * 趋势自动模拟交易 · 总览（Task 54 §5.1/§5.2）
 * GET /api/trend-trading
 * → { ok, ts, mode, service, config, account, stats, positions, recentSkips, recentDecisions }
 * 首次访问随引擎启动趋势服务与自动交易服务（幂等，从 DB 恢复持仓关联与模式）。
 * ⚠️ 纯模拟交易；统计主口径 = 含滑点估算净盈亏（手续费双边 + 滑点，不省略成本）。
 */
export async function GET() {
  try {
    const engine = getEnhancedEngine();
    await engine.ensureStarted();
    await engine.trendWatch.ensureStarted();
    await engine.autoTrader.ensureStarted();
    await ensureTrendTradeSchema();

    const now = Date.now();
    const cfg = await trendTradeRepo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    const mode = cfg?.mode ?? 'RUNNING';
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });

    const openPositions = acc
      ? await db.paperPosition.findMany({
          where: { accountId: acc.id, status: 'OPEN' },
          orderBy: { openedAt: 'desc' },
        })
      : [];
    const openMetas = await trendTradeRepo.loadMetasByStatus('OPEN');
    const metaByPosition = new Map(openMetas.map((m) => [m.positionId, m]));
    const signals = engine.trendWatch.latestSignals();
    const signalBySymbol = new Map<string, UnifiedTrendSignal>(signals.map((s) => [s.symbol, s]));

    // —— 持仓（任务 §5.2 全字段；趋势关联 = trendWatch 统一信号，不另行计算）——
    let unrealized = 0;
    let marginUsed = 0;
    const positions = openPositions.map((p) => {
      const mark = engine.autoTrader.markPriceOf(p.symbol) || p.entryPrice;
      const sign = p.side === 'LONG' ? 1 : -1;
      const upnl = (mark - p.entryPrice) * p.qty * sign;
      unrealized += upnl;
      marginUsed += p.margin;
      const meta = metaByPosition.get(p.id) ?? null;
      const signal = signalBySymbol.get(p.symbol) ?? null;
      const notional = p.qty * mark;
      const estCloseFee = notional * 0.0005;
      const estCloseSlip = notional * ((cfg?.slippageBps ?? 2) / 10_000);
      const openSlip = meta?.slippageEst ?? 0;
      return {
        positionId: p.id,
        symbol: p.symbol,
        base: p.symbol.replace(/USDT$/, ''),
        side: p.side as 'LONG' | 'SHORT',
        leverage: p.leverage,
        margin: p.margin,
        qty: p.qty,
        entryPrice: p.entryPrice,
        markPrice: mark,
        liqPrice: p.liqPrice,
        notional,
        openedAt: p.openedAt.toISOString(),
        holdMinutes: Math.max(0, Math.round((now - p.openedAt.getTime()) / 60_000)),
        unrealizedGross: upnl,
        estCloseFee,
        netEst: upnl - estCloseFee - openSlip - estCloseSlip,
        trend: signal
          ? {
              phase: signal.phase,
              direction: signal.direction,
              score: signal.score,
              dataFresh: signal.dataFresh,
              dataUnavailableReason: signal.dataUnavailableReason,
              endEvidenceBars: signal.endEvidenceBars,
              endPendingSince: signal.endPendingSince,
              trendCycleId: signal.trendCycleId,
              conflict: signal.conflict,
              reason: signal.reason,
              volRegime: signal.features.volRegime,
              htfAgree: signal.htfAgree,
            }
          : null,
        trendCycleId: meta?.trendCycleId ?? null,
        scoreAtOpen: meta?.scoreAtOpen ?? null,
        waitingEndConfirm: Boolean(
          signal && meta && signal.trendCycleId === meta.trendCycleId && signal.phase === 'END_PENDING',
        ),
      };
    });

    // —— 已实现统计（含滑点净盈亏主口径；强平计入、不省略成本）——
    const closedMetas = await trendTradeRepo.loadMetasByStatus('CLOSED');
    const closedCount = acc
      ? await db.paperPosition.count({ where: { accountId: acc.id, status: 'CLOSED' } })
      : 0;
    const liqCount = acc
      ? await db.paperPosition.count({ where: { accountId: acc.id, status: 'LIQUIDATED' } })
      : 0;
    const feeAgg = acc
      ? await db.paperTrade.aggregate({ where: { accountId: acc.id }, _sum: { fee: true } })
      : null;
    const netWithSlipSum = closedMetas.reduce((s, m) => s + (m.netPnlWithSlip ?? 0), 0);
    const wins = closedMetas.filter((m) => (m.netPnlWithSlip ?? 0) > 0).length;
    const decided = closedMetas.length;
    const balance = acc?.balance ?? 0;
    const equity = balance + marginUsed + unrealized;
    const initialCapital = cfg?.initialCapital ?? TREND_TRADE.INITIAL_CAPITAL;
    const peakEquity = Math.max(cfg?.peakEquity ?? 0, equity);
    const principal = initialCapital + (acc?.totalDeposited ?? 0);

    const recentDecisions = await trendTradeRepo.recentDecisions(30);
    // Task 57-c：参数控制台数据源——参数定义 + 当前生效值（默认+DB 覆盖合并）
    const strategyIdNow = cfg?.strategyId ?? TREND_TRADE.DEFAULT_STRATEGY_ID;
    const strategyOverrides = parseStrategyParamsMap(cfg?.strategyParamsJson)[strategyIdNow] ?? null;
    const consoleParams = effectiveRuntimeParams(strategyOverrides, {
      waitBarConfirm: cfg?.waitBarConfirm ?? null,
      cooldownMs: cfg?.cooldownMs ?? null,
    });

    return NextResponse.json(
      {
        ok: true,
        ts: now,
        mode,
        service: {
          on: engine.autoTrader.startedAt > 0,
          startedAt: engine.autoTrader.startedAt,
          lastTickAt: engine.autoTrader.lastTick,
          lastError: engine.autoTrader.lastErr,
          trendSignalCount: signals.length,
          trendLastScanAt: engine.trendWatch.snapshot(now).stats.lastScanAt,
        },
        config: {
          accountName: TREND_TRADE.ACCOUNT_NAME,
          initialCapital,
          marginRatio: cfg?.marginRatio ?? TREND_TRADE.MARGIN_RATIO,
          leverage: cfg?.leverage ?? TREND_TRADE.LEVERAGE,
          maxPositions: cfg?.maxPositions ?? TREND_TRADE.MAX_POSITIONS,
          slippageBps: cfg?.slippageBps ?? TREND_TRADE.SLIPPAGE_BPS,
          // Task 57：当前算法 + 可选策略列表（UI 下拉数据源）
          strategyId: cfg?.strategyId ?? TREND_TRADE.DEFAULT_STRATEGY_ID,
          strategies: listStrategies(),
          // Task 57-c：参数控制台（定义 + 生效值；保存走 control setRuntimeParams）
          params: consoleParams,
        },
        account: {
          balance,
          marginUsed,
          unrealizedPnl: unrealized,
          equity,
          initialCapital,
          totalDeposited: acc?.totalDeposited ?? 0,
          peakEquity,
          currentDrawdownPct: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
        },
        stats: {
          realizedNetWithSlip: netWithSlipSum,
          feePaid: feeAgg?._sum.fee ?? 0,
          winRate: decided > 0 ? (wins / decided) * 100 : 0,
          closedCount,
          liquidatedCount: liqCount,
          openCount: openPositions.length,
          tradeCount: decided + openPositions.length,
          roiPct: principal > 0 ? ((equity - principal) / principal) * 100 : 0,
        },
        positions,
        recentSkips: engine.autoTrader.recentSkips(50),
        recentDecisions: recentDecisions.map((d) => ({
          id: String(d.id),
          symbol: String(d.symbol),
          action: String(d.action),
          cycleId: String(d.cycleId),
          positionId: (d.positionId as string | null) ?? null,
          detail: String(d.detail ?? '{}'),
          createdAt: d.createdAt instanceof Date ? d.createdAt.getTime() : Number(d.createdAt),
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'trend trading error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
