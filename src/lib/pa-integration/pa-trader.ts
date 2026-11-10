// ---------- PA 整合 · PaActionTrader 执行层（任务书 §7.4/§7.5/§7.6/§八） ----------
// 职责：待入场单生命周期（MARKET/LIMIT/STOP_MARKET）→ PaperEngine 模拟成交 →
// 持仓管理（止损优先的保守规则、TP1 部分止盈、TP2 清仓、趋势失效退出）→ 全程留痕。
//
// 纪律：
// - 独立账户 pa-auto-v1（paperEngineFor per-account 实例），与 default / trend-auto-v1 隔离；
// - 成交假设（明确声明）：触发判定用「已收盘 1m K 线高低价 + 当前标记价」，成交价 =
//   触发时刻标记价（决策时点价，无未来数据）；滑点按 bps 计入净盈亏统计口径；
//   模拟成交 ≠ 真实成交（1m 内部路径未知）；
// - 保守规则：同一根 1m K 线同时触及止损与止盈 → 优先止损（禁止用 K 线内部未知路径
//   假设获得更好成交）；
// - 幂等：待入场单 id = {symbol}:{direction}:{barTime5m}（DB 主键兜底）；同一 symbol
//   至多一条 ACTIVE 待入场单 + 一个 OPEN 持仓；退出以 PaPositionMeta 状态机防重；
// - 暂停（enabled=0）只停新开仓，止损/TP/趋势失效/强平管理照常。

import { db } from '@/lib/db';
import { PaperError, paperEngineFor } from '@/lib/market/paper';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';
import { liveFuturesMark } from './market-snapshot';
import { computeRiskSizing, sumOpenRisk } from './risk-sizing';
import { PA_ACCOUNT_NAME } from './config';
import { ensurePaSchema, paRepo } from './repo';
import type { PaActionConfig, PaExitReason, PaPendingOrderRow, PaPositionMetaRow, PaTradePlan } from './types';

function log(msg: string): void {
  console.log(`[pa-action] ${msg}`);
}

export class PaActionTrader {
  private readonly engine = paperEngineFor(PA_ACCOUNT_NAME);

  /** 每仓位已处理的最后一根 1m 收盘 bar（防同根 K 线重复触发） */
  private lastProcessedBar = new Map<string, number>();

  // ============ 账户 ============

  async ensureAccount(): Promise<string> {
    let acc = await db.paperAccount.findUnique({ where: { name: PA_ACCOUNT_NAME } });
    if (!acc) {
      acc = await db.paperAccount.create({ data: { name: PA_ACCOUNT_NAME, balance: 100 } });
      log(`PA 模拟账户已初始化（${PA_ACCOUNT_NAME}，初始 100 USDT）`);
    }
    return acc.id;
  }

  private async equitySnapshot(): Promise<{ balance: number; equity: number; openCount: number }> {
    const accId = await this.ensureAccount();
    const acc = await db.paperAccount.findUnique({ where: { id: accId } });
    const open = await db.paperPosition.findMany({ where: { accountId: accId, status: 'OPEN' } });
    let marginUsed = 0;
    let unrealized = 0;
    for (const p of open) {
      const mark = liveFuturesMark(p.symbol);
      const m = mark > 0 ? mark : p.entryPrice;
      marginUsed += p.margin;
      unrealized += (m - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
    }
    const balance = acc?.balance ?? 0;
    return { balance, equity: balance + marginUsed + unrealized, openCount: open.length };
  }

  // ============ 待入场单创建（任务书 §7.4；计划已过 Validator） ============

  async createPendingOrder(
    plan: PaTradePlan,
    cfg: PaActionConfig,
    metas: PaPositionMetaRow[],
  ): Promise<{ ok: boolean; reason: string; orderId?: string }> {
    await ensurePaSchema();
    const symbol = plan.symbol;

    // 同币种防御：已有 PA 持仓或 ACTIVE 待入场单一律拒绝（任务书 §7.5/§八 幂等）
    const metasForSymbol = metas.filter((m) => m.symbol === symbol && (m.status === 'OPEN' || m.status === 'TP1_PARTIAL'));
    if (metasForSymbol.length > 0) return { ok: false, reason: '同币种已有 PA 持仓' };
    if (await paRepo.hasActivePendingForSymbol(symbol)) return { ok: false, reason: '同币种已有待入场单' };

    // 风险预算仓位（任务书 §7.5：按止损距离，不用固定保证金比例）
    const eq = await this.equitySnapshot();
    const markNow = liveFuturesMark(symbol);
    if (!(markNow > 0)) return { ok: false, reason: '标记价不可用' };
    const sizing = computeRiskSizing({
      equity: eq.equity,
      availableBalance: eq.balance,
      entry: plan.entryPrice,
      stopLoss: plan.stopLoss,
      riskPerTradePct: cfg.riskPerTradePct,
      maxTotalRiskPct: cfg.maxTotalRiskPct,
      currentTotalRisk: sumOpenRisk(metas, (s) => liveFuturesMark(s) || 0),
      leverage: cfg.leverage,
      leverageCap: cfg.leverageCap,
      feeRate: cfg.feeRate,
      tickSize: 0, // 数量精度：不按 tick 取整（保留计算精度，风险不放大）
    });
    if (!sizing.ok) return { ok: false, reason: sizing.reason ?? '风险测算未通过' };

    // MARKET 单偏离校验（创建时点）；LIMIT/STOP 单等待触发
    if (plan.orderType === 'MARKET') {
      const dev = (Math.abs(markNow - plan.entryPrice) / plan.entryPrice) * 100;
      if (dev > cfg.entryMaxDeviationPct) {
        return { ok: false, reason: `市价偏离 ${dev.toFixed(3)}% 超限（不追价）` };
      }
    }

    const id = `${symbol}:${plan.direction}:${plan.barTime5m}`;
    const row: PaPendingOrderRow = {
      id,
      symbol,
      direction: plan.direction,
      kind: plan.orderType,
      triggerPrice: plan.entryPrice,
      maxDeviationPct: cfg.entryMaxDeviationPct,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      takeProfit2: plan.takeProfit2,
      qty: sizing.qty,
      leverage: sizing.leverage,
      margin: sizing.margin,
      status: 'ACTIVE',
      cancelReason: null,
      positionId: null,
      planId: plan.analysisId,
      analysisId: plan.analysisId,
      barTime5m: plan.barTime5m,
      createdAt: Date.now(),
      triggeredAt: null,
      updatedAt: Date.now(),
    };
    const created = await paRepo.savePendingOrder(row);
    if (!created) return { ok: false, reason: '待入场单已存在（幂等拦截）' };
    log(
      `待入场单创建 ${id} kind=${plan.orderType} trigger=${plan.entryPrice} qty=${sizing.qty.toFixed(6)} ` +
      `margin=${sizing.margin.toFixed(2)} lev=${sizing.leverage}x risk=${sizing.riskAmount.toFixed(2)}U`,
    );
    return { ok: true, reason: 'created', orderId: id };
  }

  // ============ 执行主循环（5s；与 AI 分析完全解耦——绝不等待 AI） ============

  private ticking = false;

  async executionTick(cfg: PaActionConfig): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await ensurePaSchema();
      const accId = await this.ensureAccount();
      const now = Date.now();

      // ① 强平巡检（任何模式都执行）
      await this.engine.liquidationCheck(accId);
      await this.finalizeLiquidations();

      // ② 持仓管理（止损/TP1/TP2/趋势失效——暂停模式也执行）
      await this.managePositions(cfg, now);

      // ③ 待入场单触发（仅启用时；暂停停新开仓但不动已有单的取消巡检）
      await this.expireAndValidatePendings(cfg, now);
      if (cfg.enabled === 1) {
        await this.triggerPendings(cfg, now);
      }
    } catch (e) {
      log(`执行循环失败：${e instanceof Error ? e.message : e}`);
    } finally {
      this.ticking = false;
    }
  }

  // ============ 待入场单：过期 / 触发 ============

  private async expireAndValidatePendings(cfg: PaActionConfig, now: number): Promise<void> {
    const actives = await paRepo.loadPendingOrders('ACTIVE');
    const signals = new Map(getEnhancedEngine().trendWatch.latestSignals().map((s) => [s.symbol, s]));
    for (const p of actives) {
      // ① 计划过期
      if (now - p.createdAt > cfg.orderExpiryMs) {
        await this.cancelPending(p, '订单过期（orderExpiryMs）');
        continue;
      }
      // ② 趋势失效（UTE 相位不再确认 / 周期变化 / 数据过期）
      const sig = signals.get(p.symbol);
      if (!sig || !sig.dataFresh) {
        await this.cancelPending(p, sig ? `数据过期（${sig.dataUnavailableReason ?? '未知'}）` : '信号缺失（退池/未评估）');
        continue;
      }
      const wantPhase = p.direction === 'LONG' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN';
      if (sig.phase !== wantPhase) {
        await this.cancelPending(p, `趋势失效（phase=${sig.phase}）`);
        continue;
      }
      if (p.planId && sig.trendCycleId && !p.planId.includes(sig.trendCycleId.split(':')[0])) {
        // 周期 symbol 归属校验（宽松：cycleId 首段为 symbol）
        await this.cancelPending(p, '趋势周期变更');
        continue;
      }
    }
  }

  private async cancelPending(p: PaPendingOrderRow, reason: string): Promise<void> {
    if (p.status !== 'ACTIVE') return;
    await paRepo.updatePendingOrder(p.id, { status: 'CANCELLED', cancelReason: reason, updatedAt: Date.now() });
    log(`待入场单取消 ${p.id} 原因=${reason}`);
  }

  /** 撤销指定待入场单（API 入口） */
  async cancelOrder(orderId: string, reason = '手动撤销'): Promise<{ ok: boolean; message: string }> {
    const p = await paRepo.getPendingOrder(orderId);
    if (!p) return { ok: false, message: '待入场单不存在' };
    if (p.status !== 'ACTIVE') return { ok: false, message: `订单状态为 ${p.status}，无法撤销` };
    await this.cancelPending(p, reason);
    return { ok: true, message: '已撤销' };
  }

  private async triggerPendings(cfg: PaActionConfig, now: number): Promise<void> {
    const eq = await this.equitySnapshot();
    const actives = await paRepo.loadPendingOrders('ACTIVE');
    for (const p of actives) {
      if (eq.openCount >= cfg.maxPositions) {
        log(`待入场单等待容量 ${p.id}（已达最大持仓数 ${cfg.maxPositions}）`);
        continue;
      }
      const mark = liveFuturesMark(p.symbol);
      if (!(mark > 0)) continue;
      const long = p.direction === 'LONG';

      let shouldFill = false;
      let fillRef = p.triggerPrice;
      if (p.kind === 'MARKET') {
        const dev = (Math.abs(mark - p.triggerPrice) / p.triggerPrice) * 100;
        if (dev <= p.maxDeviationPct) shouldFill = true;
        else {
          await this.cancelPending(p, `市价偏离 ${dev.toFixed(3)}% 超限（不追价）`);
          continue;
        }
      } else if (p.kind === 'LIMIT') {
        // 限价：多头等回调至 ≤ 限价；空头等反弹至 ≥ 限价；成交价 = 触发时刻标记价
        if ((long && mark <= p.triggerPrice) || (!long && mark >= p.triggerPrice)) {
          shouldFill = true;
          fillRef = mark;
        }
      } else if (p.kind === 'STOP_MARKET') {
        // 突破：多头上破触发价；空头上… 下破触发价；滑点由标记价自然反映
        if ((long && mark >= p.triggerPrice) || (!long && mark <= p.triggerPrice)) {
          shouldFill = true;
          fillRef = mark;
        }
      }
      if (!shouldFill) continue;

      // 幂等抢占：置 TRIGGERED 后再开仓（并发 tick 防重）
      await paRepo.updatePendingOrder(p.id, { status: 'TRIGGERED', triggeredAt: now, updatedAt: now });
      try {
        const pos = await this.engine.open({
          symbol: p.symbol,
          side: p.direction,
          leverage: p.leverage,
          margin: p.margin,
        });
        await paRepo.updatePendingOrder(p.id, { positionId: pos.id, updatedAt: now });
        // 绑定当前真实 UTE 周期（ENDED/反向退出的周期匹配基准；无信号时用 PA 占用周期）
        const sig = getEnhancedEngine().trendWatch.latestSignals().find((s) => s.symbol === p.symbol);
        const cycleId = sig?.trendCycleId ?? `PA:${p.symbol}:${now}`;
        const meta: PaPositionMetaRow = {
          positionId: pos.id,
          symbol: p.symbol,
          side: p.direction,
          status: 'OPEN',
          planId: p.planId,
          analysisId: p.analysisId,
          trendCycleId: cycleId,
          stopLoss: p.stopLoss,
          takeProfit1: p.takeProfit1,
          takeProfit2: p.takeProfit2,
          initialQty: pos.qty,
          remainingQty: pos.qty,
          tp1Done: 0,
          tp2Done: 0,
          breakevenMoved: 0,
          realizedPnl: 0,
          exitReason: null,
          openedAt: now,
          closedAt: null,
          updatedAt: now,
        };
        await paRepo.savePositionMeta(meta);
        this.lastProcessedBar.set(pos.id, 0);
        const slip = pos.qty * (fillRef ?? mark) * (cfg.slippageBps / 10_000);
        log(
          `模拟成交 ${p.kind} ${p.symbol} ${p.direction} positionId=${pos.id} ref=${(fillRef ?? mark).toFixed(6)} ` +
          `qty=${pos.qty.toFixed(6)} margin=${p.margin.toFixed(2)} slipEst=${slip.toFixed(4)}U pendingId=${p.id}`,
        );
        eq.openCount += 1;
      } catch (e) {
        // 开仓失败（行情/资金类）：回滚为 CANCELLED 并记录；绝不静默重试烧周期
        const msg = e instanceof PaperError ? e.message : String(e);
        await paRepo.updatePendingOrder(p.id, {
          status: 'CANCELLED',
          cancelReason: `触发后开仓失败：${msg}`,
          updatedAt: now,
        });
        log(`待入场单触发失败 ${p.id}：${msg}`);
      }
    }
  }

  // ============ 持仓管理：止损（优先）→ TP1 → TP2 → 趋势失效 ============

  private async managePositions(cfg: PaActionConfig, now: number): Promise<void> {
    const metas = await paRepo.loadPositionMetas('OPEN');
    if (metas.length === 0) return;
    const engine = getEnhancedEngine();
    const signals = new Map(engine.trendWatch.latestSignals().map((s) => [s.symbol, s]));

    for (const meta of metas) {
      const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (!pos || pos.status !== 'OPEN') continue;
      const mark = liveFuturesMark(meta.symbol);
      if (!(mark > 0)) continue;
      const long = meta.side === 'LONG';

      // 已收盘 1m K 线（触发判定）：只处理「未处理过」的最新 bar + 当前标记价
      const bars = engine.store.closedCandles(meta.symbol, 30 * 60_000, now);
      const lastBar = bars.length ? bars[bars.length - 1] : null;
      const processed = this.lastProcessedBar.get(meta.positionId) ?? 0;

      // ① 趋势失效退出（UTE ENDED / 反向确认）——周期精确匹配（同 AutoPaperTrader §2.2 语义：
      //   旧周期 ENDED 不杀新周期持仓，也不仅凭 symbol 平仓）
      const sig = signals.get(meta.symbol);
      if (sig && sig.dataFresh) {
        if (
          sig.phase === 'ENDED' &&
          sig.trendCycleId != null &&
          meta.trendCycleId === sig.trendCycleId &&
          (sig.lastBarTime == null || sig.lastBarTime > meta.openedAt)
        ) {
          await this.closeRemaining(meta, 'TREND_ENDED', mark, `UTE 趋势已结束（phase=ENDED cycle=${sig.trendCycleId}）`);
          continue;
        }
        const wantPhase = long ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN';
        if ((sig.phase === 'CONFIRMED_UP' || sig.phase === 'CONFIRMED_DOWN') && sig.phase !== wantPhase && sig.dataFresh) {
          await this.closeRemaining(meta, 'REVERSE_CONFIRMED', mark, `反向趋势确认（${sig.phase}）`);
          continue;
        }
      }

      // ② 触发检测（保守：止损优先于止盈——同根 K 线同时触及只认止损）
      const barTouchStop = lastBar != null && lastBar.t > processed && (long ? lastBar.l <= meta.stopLoss : lastBar.h >= meta.stopLoss);
      const markTouchStop = long ? mark <= meta.stopLoss : mark >= meta.stopLoss;
      const barTouchTp1 = lastBar != null && lastBar.t > processed && (long ? lastBar.h >= meta.takeProfit1 : lastBar.l <= meta.takeProfit1);
      const barTouchTp2 = lastBar != null && lastBar.t > processed && (long ? lastBar.h >= meta.takeProfit2 : lastBar.l <= meta.takeProfit2);
      const markTouchTp1 = long ? mark >= meta.takeProfit1 : mark <= meta.takeProfit1;
      const markTouchTp2 = long ? mark >= meta.takeProfit2 : mark <= meta.takeProfit2;

      if (barTouchStop || markTouchStop) {
        await this.closeRemaining(meta, 'STOP_LOSS', long ? Math.min(mark, meta.stopLoss) : Math.max(mark, meta.stopLoss), '止损触发（保守规则：同K线止损优先）');
        continue;
      }

      // ③ TP1 部分止盈（默认 50%；仅一次）
      if (meta.tp1Done === 0 && (barTouchTp1 || markTouchTp1)) {
        const tp1Qty = Math.min(meta.initialQty * cfg.tp1CloseRatio, meta.remainingQty);
        try {
          const r = await this.engine.closePartial(meta.positionId, tp1Qty);
          const updated: PaPositionMetaRow = {
            ...meta,
            status: 'TP1_PARTIAL',
            tp1Done: 1,
            remainingQty: meta.remainingQty - r.closeQty,
            realizedPnl: meta.realizedPnl + r.pnl,
            updatedAt: now,
          };
          // TP1 后止损移保本（可配置，默认关闭——不擅改 PA 原始计划）
          if (cfg.breakevenAfterTp1 === 1) {
            const be = pos.entryPrice;
            const beSafe = long ? Math.min(be, meta.takeProfit1 - (meta.takeProfit2 - meta.takeProfit1) * 0.1) : Math.max(be, meta.takeProfit1 + (meta.takeProfit1 - meta.takeProfit2) * 0.1);
            updated.stopLoss = beSafe;
            updated.breakevenMoved = 1;
          }
          await paRepo.savePositionMeta(updated);
          this.lastProcessedBar.set(meta.positionId, lastBar?.t ?? 0);
          log(`TP1 部分止盈 ${meta.symbol} ${meta.side} closeQty=${r.closeQty.toFixed(6)} pnl=${r.pnl.toFixed(4)} 剩余=${updated.remainingQty.toFixed(6)}${updated.breakevenMoved ? ' 止损已移保本' : ''}`);
          if (updated.remainingQty <= 1e-12) continue;
          // TP1 当根 K 线若已触及 TP2：保守起见本轮不做 TP2（等下一根/标记价判定）
          if (!(barTouchTp2 || markTouchTp2)) continue;
          // fall-through 到 TP2（用最新 meta）
          const cur = await paRepo.getPositionMeta(meta.positionId);
          if (cur) {
            await this.closeRemaining(cur, 'TP2_FINAL', mark, 'TP2 触发，清仓剩余仓位');
          }
          continue;
        } catch (e) {
          log(`TP1 部分平仓失败 ${meta.symbol}：${e instanceof Error ? e.message : e}`);
          continue;
        }
      }

      // ④ TP2 清仓（剩余全部）
      if (meta.tp1Done === 1 && (barTouchTp2 || markTouchTp2)) {
        await this.closeRemaining(meta, 'TP2_FINAL', mark, 'TP2 触发，清仓剩余仓位');
        continue;
      }

      // 推进已处理 bar（本轮无触发的仓位）
      if (lastBar) this.lastProcessedBar.set(meta.positionId, lastBar.t);
    }
  }

  /** 平掉剩余全部仓位并终态化 meta（幂等：先重读 meta 状态） */
  async closeRemaining(metaIn: PaPositionMetaRow, reason: PaExitReason, _priceHint: number, detail: string): Promise<void> {
    void _priceHint;
    const meta = (await paRepo.getPositionMeta(metaIn.positionId)) ?? metaIn;
    if (meta.status === 'CLOSED' || meta.status === 'CANCELLED') return;
    const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
    if (!pos || pos.status !== 'OPEN') {
      await paRepo.savePositionMeta({ ...meta, status: 'CLOSED', exitReason: reason, closedAt: Date.now(), updatedAt: Date.now() });
      return;
    }
    try {
      const r = await this.engine.closePartial(meta.positionId, null); // 全仓
      await paRepo.savePositionMeta({
        ...meta,
        status: 'CLOSED',
        remainingQty: 0,
        realizedPnl: meta.realizedPnl + r.pnl,
        exitReason: reason,
        closedAt: Date.now(),
        updatedAt: Date.now(),
      });
      log(
        `平仓 reason=${reason} ${meta.symbol} ${meta.side} positionId=${meta.positionId} price=${r.price.toFixed(6)} ` +
        `closeQty=${r.closeQty.toFixed(6)} pnl=${r.pnl.toFixed(4)} 累计=${(meta.realizedPnl + r.pnl).toFixed(4)} detail=${detail}`,
      );
    } catch (e) {
      // 暂时性失败（行情不可用）：不终态化，下轮重试
      log(`平仓失败 reason=${reason} ${meta.symbol}：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 手动平仓（API 入口） */
  async closeOne(positionId: string): Promise<{ ok: boolean; message: string }> {
    const meta = await paRepo.getPositionMeta(positionId);
    if (!meta || meta.status === 'CLOSED' || meta.status === 'CANCELLED') return { ok: false, message: 'PA 持仓不存在或已平仓' };
    const mark = liveFuturesMark(meta.symbol);
    await this.closeRemaining(meta, 'MANUAL', mark, '手动平仓');
    return { ok: true, message: '已提交平仓' };
  }

  // ============ 强平终态化 ============

  private async finalizeLiquidations(): Promise<void> {
    const metas = await paRepo.loadPositionMetas('OPEN');
    for (const meta of metas) {
      const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (pos && pos.status === 'LIQUIDATED') {
        await paRepo.savePositionMeta({
          ...meta,
          status: 'CLOSED',
          remainingQty: 0,
          exitReason: 'LIQUIDATED',
          realizedPnl: meta.realizedPnl + (pos.pnl ?? -pos.margin),
          closedAt: Date.now(),
          updatedAt: Date.now(),
        });
        log(`强平终态化 ${meta.symbol} ${meta.side} positionId=${meta.positionId} pnl=${(pos.pnl ?? -pos.margin).toFixed(4)}`);
      }
    }
  }

  // ============ 汇总（页面用） ============

  async overview() {
    const accId = await this.ensureAccount();
    const eq = await this.equitySnapshot();
    const pendings = await paRepo.loadPendingOrders('ACTIVE');
    const metas = await paRepo.loadPositionMetas('OPEN');
    return { accId, ...eq, activePendings: pendings.length, openPositions: metas.length };
  }
}
