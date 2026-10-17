# -*- coding: utf-8 -*-
"""Task 57: auto-trader.ts 剩余策略化替换（每个替换断言命中，防静默失败）"""
import sys

P = '/home/z/my-project/src/lib/market/trend-trade/auto-trader.ts'
src = open(P, encoding='utf-8').read()
count = 0

def rep(old, new, tag):
    global src, count
    n = src.count(old)
    assert n >= 1, f'[{tag}] NOT FOUND (count={n})'
    src = src.replace(old, new, 1)
    count += 1
    print(f'ok[{count}] {tag}')

# 1) managePendings 标题与注释
rep("""  // ============ 开仓决策 ============

  /**
   * 待入场管理（§5.3 二次确认）：每个 ACTIVE 待入场记录在出现「更新的已收盘 K 线」后
   * 全量复核（相位/周期/数据/质量门槛/冷却/容量/资金），通过才开仓；趋势失效、数据过期、
   * 门槛不再满足或记录过期 → 取消并记录原因。每周期至多一条记录、只允许成功开仓一次
   * （决策键 `{cycleId}:OPEN` 数据库唯一约束兜底）。
   */""",
"""  // ============ 待入场转换 / 新信号扫描（Task 57：门槛判定全部由当前策略执行） ============

  /**
   * 待入场管理（二次确认）：每个 ACTIVE 待入场记录在出现「更新的已收盘 K 线」后
   * 全量复核（策略门槛/相位/周期/数据/冷却/容量/资金），通过才开仓；趋势失效、数据过期、
   * 门槛不再满足或记录过期 → 取消并记录原因。每轮次至多一条记录、只允许成功开仓一次
   * （决策键 `{cycleId}#R{round}:OPEN` 数据库唯一约束兜底）。
   */""", 'pendings-header')

# 2) cancel 日志
rep("""        logDecision(
          `待入场取消 cycle=${p.cycleId} symbol=${p.symbol} reason=${reason} ` +""",
"""        logDecision(
          `待入场取消 roundKey=${p.cycleId} symbol=${p.symbol} reason=${reason} ` +""", 'cancel-log')

# 3) ② 周期比较 baseCycleOf
rep("""        signal.trendCycleId !== p.cycleId
      ) {
        await cancel(`趋势失效（phase=${signal.phase}，cycle=${signal.trendCycleId ?? '-'}）`);
        continue;
      }
      // ③ 还没等到「新的已收盘 K 线」→ 继续等待（§5.3 核心等待条件）
      if (signal.lastBarTime == null || signal.lastBarTime <= p.firstBarTime) continue;
      // ④ 冷却复核（§5.4：冷却以 symbol 为单位，不因周期变化绕过）""",
"""        signal.trendCycleId !== baseCycleOf(p.cycleId)
      ) {
        await cancel(`趋势失效（phase=${signal.phase}，cycle=${signal.trendCycleId ?? '-'}）`);
        continue;
      }
      // ③ 还没等到「新的已收盘 K 线」→ 继续等待（二次确认核心等待条件）
      if (signal.lastBarTime == null || signal.lastBarTime <= p.firstBarTime) continue;
      // ④ 冷却复核：冷却以 symbol 为单位，不因周期/轮次变化绕过""", 'cycle-base')

# 4) ⑤ 策略门槛复核
rep("""      // ⑤ 质量门槛全量复核（趋势方向/阶段/评分/ER/高周期过滤）
      const gateReason = this.entryGateCheck(signal);
      if (gateReason) {
        await cancel(`复核未过门槛：${gateReason}`);
        continue;
      }""",
"""      // ⑤ 策略门槛全量复核（方向/模式/评分/ER/轮次——与创建时同一策略判定）
      const ctx = this.strategyCtx(
        Date.now(),
        this.deps.markPrice(p.symbol),
        cfg,
        eq,
        new Set(),
        lastClose,
      );
      const verdict = this.strategy.evaluateEntry(signal, ctx);
      if (!verdict.want) {
        await cancel(`复核未过门槛：${verdict.reason}`);
        continue;
      }""", 'pendings-strategy-gate')

# 5) ⑧ 注释
rep('      // ⑧ 仓位测算（§六：每仓保证金 = 开仓时账户权益 × 20%；超出可用余额直接跳过）',
    '      // ⑧ 仓位测算（每仓保证金 = 开仓时账户权益 × 20%；超出可用余额直接跳过）', 'sizing-note')

# 6) ⑨ claim OPEN
rep("""      // ⑨ 幂等守卫（数据库唯一约束兜底）：抢占 `{cycleId}:OPEN` 决策
      const claimed = await this.repo.claimDecision({
        id: `${p.cycleId}:OPEN`,
        symbol: p.symbol,
        action: 'OPEN',
        cycleId: p.cycleId,
        detail: JSON.stringify(this.openDetail(signal, targetMargin, cfg)),
      });
      if (!claimed) {
        await cancel('本趋势周期已决策过（幂等）');
        continue;
      }""",
"""      // ⑨ 幂等守卫（数据库唯一约束兜底）：抢占 `{cycleId}#R{round}:OPEN` 决策
      const claimed = await this.repo.claimDecision({
        id: `${p.cycleId}:OPEN`,
        symbol: p.symbol,
        action: 'OPEN',
        cycleId: baseCycleOf(p.cycleId),
        detail: JSON.stringify(this.openDetail(signal, targetMargin, cfg, verdict.modeTag)),
      });
      if (!claimed) {
        await cancel('本趋势周期本轮次已决策过（幂等）');
        continue;
      }""", 'claim-open')

# 7) upsertMeta 段（trendCycleId/featuresAtOpen/entryRound/onOpen/日志）
rep("""        const slippageEst = targetMargin * cfg.leverage * (cfg.slippageBps / 10_000);
        await this.repo.upsertMeta({
          positionId: pos.id,
          trendCycleId: p.cycleId,
          symbol: p.symbol,
          side: p.side,
          trendPhaseAtOpen: signal.phase,
          scoreAtOpen: signal.score,
          featuresAtOpen: JSON.stringify({
            vol: signal.features,""",
"""        const slippageEst = targetMargin * cfg.leverage * (cfg.slippageBps / 10_000);
        const posCycle = baseCycleOf(p.cycleId);
        await this.repo.upsertMeta({
          positionId: pos.id,
          trendCycleId: posCycle,
          symbol: p.symbol,
          side: p.side,
          trendPhaseAtOpen: signal.phase,
          scoreAtOpen: signal.score,
          featuresAtOpen: JSON.stringify({
            strategyId: this.strategy.id,
            modeTag: verdict.modeTag,
            vol: signal.features,""", 'upsert-meta-head')

rep("""          // Task 56 §七：开仓快照（可查询列）
          entryEr: signal.features.efficiencyRatio,""",
"""          // 开仓快照（可查询列）
          entryEr: signal.features.efficiencyRatio,""", 'meta-snapshot-note')

rep("""          closeNotional: null,
        });
        await this.repo.markPendingConverted(p.cycleId, pos.id);
        await this.attachPosition(`${p.cycleId}:OPEN`, pos.id);
        this.opens++;
        eq.openCount += 1;
        eq.marginUsed += targetMargin;
        eq.balance -= targetMargin + fee;
        eq.equity -= fee; // equity = balance + marginUsed + unrealized 自洽（开仓瞬时浮亏≈0）
        logDecision(
          `开仓（二次确认通过）symbol=${p.symbol} side=${p.side} posCycle=${p.cycleId} ` +""",
"""          closeNotional: null,
          entryRound: pendingRoundOf(p.cycleId),
        });
        await this.repo.markPendingConverted(p.cycleId, pos.id);
        await this.attachPosition(`${p.cycleId}:OPEN`, pos.id);
        // 策略回调：轮次 +1 / 新周期初始化（持久化到 TrendStrategyState）
        this.strategy.onOpen(p.symbol, posCycle, signal.lastBarTime, Date.now());
        this.opens++;
        eq.openCount += 1;
        eq.marginUsed += targetMargin;
        eq.balance -= targetMargin + fee;
        eq.equity -= fee; // equity = balance + marginUsed + unrealized 自洽（开仓瞬时浮亏≈0）
        logDecision(
          `开仓（二次确认通过）strategy=${this.strategy.id} mode=${verdict.modeTag} round=${pendingRoundOf(p.cycleId)} ` +
            `symbol=${p.symbol} side=${p.side} posCycle=${posCycle} ` +""", 'onopen-log')

# 8) manageEntries 整段重写
rep("""  /**
   * 新信号扫描（§5.3）：首次满足「确认相位 + 数据新鲜 + 质量门槛 + 冷却结束 + 容量 +
   * 独立性」的确认趋势，只创建待入场记录（等待下一根已收盘 K 线），不立即下单。
   */
  private async manageEntries(
    cfg: TrendAutoConfigRow,
    signals: UnifiedTrendSignal[],
    eq: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number },
  ): Promise<void> {
    // 容量核算：已开仓 + 待入场（其 symbol 无持仓者，复核后将各占一仓）共同计入上限——
    // 防止待入场批量创建超过 maxPositions（转换层另有二次守卫）
    const accountId = await this.autoAccountId();
    const openRows = await db.paperPosition.findMany({ where: { accountId, status: 'OPEN' } });
    const openSymbols = new Set(openRows.map((p) => p.symbol));
    const activePendings = await this.repo.loadActivePendings();
    const pendingSymbols = new Set(
      activePendings.filter((p) => !openSymbols.has(p.symbol)).map((p) => p.symbol),
    );

    for (const signal of signals) {
      if (!(TREND_TRADE.CONFIRMED_PHASES as readonly string[]).includes(signal.phase)) continue; // 候选趋势不开仓
      if (!signal.dataFresh) {
        this.pushSkip(signal.symbol, '数据不可用/过期（不开新仓）', signal.trendCycleId ?? undefined);
        continue;
      }
      const cycleId = signal.trendCycleId;
      if (!cycleId) continue;
      const side = signal.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT';

      // 幂等守卫 1：同 symbol 已有 OPEN 关联持仓（防御；正常由周期决策键保证）
      if (openSymbols.has(signal.symbol)) continue;

      // 本周期已存在待入场记录（ACTIVE/CONVERTED/CANCELED 任一）：不重复创建
      const existing = await this.repo.getPendingByCycle(cycleId);
      if (existing) continue;

      // 容量守卫（跳过不烧周期：仓位/待入场释放后同一确认趋势仍可创建待入场）
      if (eq.openCount + pendingSymbols.size >= cfg.maxPositions) {
        this.recordSkip(signal.symbol, `已达最大持仓数 ${cfg.maxPositions}`, cycleId);
        continue;
      }

      // 同币种冷却（§5.4）：平仓后 5 分钟内新信号只记录不执行；到期后重走完整门槛
      const lastClose = await this.repo.lastCloseAt(signal.symbol);
      if (lastClose != null && Date.now() - lastClose < TREND_TRADE.COOLDOWN_MS) {
        this.recordSkip(
          signal.symbol,
          `同币种冷却中（距上次平仓 ${Math.ceil((Date.now() - lastClose) / 1000)}s / ${TREND_TRADE.COOLDOWN_MS / 1000}s）`,
          cycleId,
        );
        continue;
      }

      // 「先平后开」独立性：确认评估包含的已收盘 K 线必须晚于该 symbol 上一笔平仓
      // （同一根 K 线不既触发平仓又触发反向开仓；首笔无平仓记录直接放行）
      if (TREND_TRADE.REVERSE_INDEPENDENT_BARS && lastClose != null) {
        if (signal.lastBarTime != null && signal.lastBarTime + 60_000 <= lastClose) {
          this.recordSkip(signal.symbol, '等待平仓后下一根已收盘 K 线确认（先平后开）', cycleId);
          continue;
        }
      }

      // 入场质量门槛（评分/ER/高周期过滤）——不满足只记录原因，不创建待入场
      const gateReason = this.entryGateCheck(signal);
      if (gateReason) {
        this.recordSkip(signal.symbol, `入场门槛未过：${gateReason}`, cycleId);
        continue;
      }

      // 创建待入场记录（每周期一条，数据库主键兜底幂等）；等待下一根已收盘 K 线复核
      const claimed = await this.repo.claimPending({
        cycleId,
        symbol: signal.symbol,
        side,
        firstBarTime: signal.lastBarTime ?? Date.now(),
        firstSeenAt: Date.now(),
        snapshotJson: JSON.stringify(signal),
        status: 'ACTIVE',
        cancelReason: null,
        openPositionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (claimed) {
        pendingSymbols.add(signal.symbol); // 同轮循环内容量即时收紧
        logDecision(
          `待入场创建（首次确认，等待下一根已收盘 K 线复核）symbol=${signal.symbol} side=${side} ` +
            `posCycle=${cycleId} firstBar=${signal.lastBarTime} score=${signal.score.toFixed(0)} ` +
            `er=${signal.features.efficiencyRatio.toFixed(2)} htf5m=${signal.htf5m.dir} htf15m=${signal.htf15m.dir}`,
        );
      }
    }
  }""",
"""  /**
   * 新信号扫描（Task 57）：对每个「数据新鲜 + 确认相位」的趋势信号询问当前策略是否想开仓
   * （方向/模式/评分/ER/轮次上限全部由策略判定）；想开仓时只创建待入场记录
   * （主键 `{cycleId}#R{round}`，等待下一根已收盘 K 线复核），不立即下单。
   * 同周期轮次上限、同周期再入场间隔与新 K 线要求由策略内部约束。
   */
  private async manageEntries(
    cfg: TrendAutoConfigRow,
    signals: UnifiedTrendSignal[],
    eq: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number },
  ): Promise<void> {
    // 容量核算：已开仓 + 待入场（其 symbol 无持仓者，复核后将各占一仓）共同计入上限——
    // 防止待入场批量创建超过 maxPositions（转换层另有二次守卫）
    const accountId = await this.autoAccountId();
    const openRows = await db.paperPosition.findMany({ where: { accountId, status: 'OPEN' } });
    const openSymbols = new Set(openRows.map((p) => p.symbol));
    const activePendings = await this.repo.loadActivePendings();
    const pendingSymbols = new Set(
      activePendings.filter((p) => !openSymbols.has(p.symbol)).map((p) => p.symbol),
    );

    for (const signal of signals) {
      // 非确认相位静默跳过（策略同样判定；此处仅为避免审计日志被「未确认」刷屏）
      if (!(TREND_TRADE.CONFIRMED_PHASES as readonly string[]).includes(signal.phase)) continue;
      if (!signal.dataFresh) {
        this.pushSkip(signal.symbol, '数据不可用/过期（不开新仓）', signal.trendCycleId ?? undefined);
        continue;
      }
      const cycleId = signal.trendCycleId;
      if (!cycleId) continue;

      // 幂等守卫 1：同 symbol 已有 OPEN 关联持仓（防御；正常由周期决策键保证）
      if (openSymbols.has(signal.symbol)) continue;

      // 本 symbol 已存在 ACTIVE 待入场记录（含历史轮次键）：不重复创建
      const activePending = await this.repo.getActivePendingBySymbol(signal.symbol);
      if (activePending) continue;

      // 本轮次决策已抢占过（幂等键烧毁保护——转换层取消的场景由 pending 重建覆盖）
      const round = this.strategy.nextRound(signal.symbol, cycleId);
      const rKey = roundKey(cycleId, round);
      const prevRound = await this.repo.getPendingByCycle(rKey);
      if (prevRound) {
        if (prevRound.status === 'ACTIVE' || prevRound.status === 'CONVERTED') continue;
        // CANCELED：删除后同轮次可重建（容量/冷却等暂时性取消不烧轮次；审计留决策行）
        await this.repo.deletePending(rKey);
      }

      // 容量守卫（跳过不烧轮次：仓位/待入场释放后同一确认趋势仍可创建待入场）
      if (eq.openCount + pendingSymbols.size >= cfg.maxPositions) {
        this.recordSkip(signal.symbol, `已达最大持仓数 ${cfg.maxPositions}`, rKey);
        continue;
      }

      // 同币种冷却：平仓后 5 分钟内新信号只记录不执行；到期后重走完整门槛
      const lastClose = await this.repo.lastCloseAt(signal.symbol);
      if (lastClose != null && Date.now() - lastClose < TREND_TRADE.COOLDOWN_MS) {
        this.recordSkip(
          signal.symbol,
          `同币种冷却中（距上次平仓 ${Math.ceil((Date.now() - lastClose) / 1000)}s / ${TREND_TRADE.COOLDOWN_MS / 1000}s）`,
          rKey,
        );
        continue;
      }

      // 「先平后开」独立性：确认评估包含的已收盘 K 线必须晚于该 symbol 上一笔平仓
      // （同一根 K 线不既触发平仓又触发反向开仓；首笔无平仓记录直接放行）
      if (TREND_TRADE.REVERSE_INDEPENDENT_BARS && lastClose != null) {
        if (signal.lastBarTime != null && signal.lastBarTime + 60_000 <= lastClose) {
          this.recordSkip(signal.symbol, '等待平仓后下一根已收盘 K 线确认（先平后开）', rKey);
          continue;
        }
      }

      // 策略入场评估（方向/模式/门槛/轮次——唯一决策来源）
      const mark = this.deps.markPrice(signal.symbol);
      if (!(mark > 0)) {
        this.pushSkip(signal.symbol, '标记价不可用（跳过本 tick）', rKey);
        continue;
      }
      const ctx = this.strategyCtx(Date.now(), mark, cfg, eq, openSymbols, lastClose);
      const verdict = this.strategy.evaluateEntry(signal, ctx);
      if (!verdict.want) {
        this.recordSkip(signal.symbol, `策略不入场：${verdict.reason}`, rKey);
        continue;
      }
      const side = verdict.side ?? (signal.phase === 'CONFIRMED_UP' ? 'LONG' : 'SHORT');

      // 创建待入场记录（每轮次一条，数据库主键兜底幂等）；等待下一根已收盘 K 线复核
      const claimed = await this.repo.claimPending({
        cycleId: rKey,
        symbol: signal.symbol,
        side,
        firstBarTime: signal.lastBarTime ?? Date.now(),
        firstSeenAt: Date.now(),
        snapshotJson: JSON.stringify({ signal, modeTag: verdict.modeTag, reason: verdict.reason }),
        status: 'ACTIVE',
        cancelReason: null,
        openPositionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (claimed) {
        pendingSymbols.add(signal.symbol); // 同轮循环内容量即时收紧
        logDecision(
          `待入场创建（strategy=${this.strategy.id} mode=${verdict.modeTag} round=${round}，等待下一根已收盘 K 线复核）` +
            `symbol=${signal.symbol} side=${side} posCycle=${cycleId} firstBar=${signal.lastBarTime} ` +
            `score=${signal.score.toFixed(0)} er=${signal.features.efficiencyRatio.toFixed(2)} ` +
            `htf5m=${signal.htf5m.dir} htf15m=${signal.htf15m.dir} verdict=${verdict.reason}`,
        );
      }
    }
  }""", 'manage-entries-rewrite')

# 9) openDetail 签名与内容
rep("""  private openDetail(signal: UnifiedTrendSignal, margin: number, cfg: TrendAutoConfigRow) {
    return {
      phase: signal.phase,""",
"""  private openDetail(signal: UnifiedTrendSignal, margin: number, cfg: TrendAutoConfigRow, modeTag: string) {
    return {
      strategyId: this.strategy.id,
      modeTag,
      phase: signal.phase,""", 'open-detail')

# 10) pendingRoundOf 辅助函数（挂在 baseCycleOf 之后）
rep("""/** 从轮次化键取回纯周期 id（持仓关联/周期匹配仍用纯 cycleId） */
function baseCycleOf(key: string): string {
  const i = key.indexOf('#');
  return i > 0 ? key.slice(0, i) : key;
}""",
"""/** 从轮次化键取回纯周期 id（持仓关联/周期匹配仍用纯 cycleId） */
function baseCycleOf(key: string): string {
  const i = key.indexOf('#');
  return i > 0 ? key.slice(0, i) : key;
}

/** 从轮次化键解析轮次号（`{cycleId}#R{n}` → n；无轮次后缀按 1） */
function pendingRoundOf(key: string): number {
  const m = key.match(/#R(\\d+)$/);
  return m ? Number(m[1]) : 1;
}""", 'pending-round-of')

# 11) 无需额外成员（轮次上限完全由策略 evaluateEntry 内部约束）

open(P, 'w', encoding='utf-8').write(src)
print(f'ALL DONE: {count} replacements')
