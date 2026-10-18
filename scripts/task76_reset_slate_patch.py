# -*- coding: utf-8 -*-
"""
Task 76：重置/清场链路修复
① auto-trader.resetAccount：tick 屏障（等在飞 tick/事件轮结束并拦住新 tick）+ 清空内存跳过面板
   ——用户看到的「已达最大持仓数 2」是重置/平仓前残留的内存跳过记录（幽灵记录），DB 实际已清干净
② auto-trader 新增 cancelActivePendings / clearSkipHistory / acquireTickBarrier
③ setStrategyId：改用 cancelActivePendings（行为不变 + 决策审计行）并清跳过面板
④ control.setMaxPositions：清场三件套（平仓 + 作废待入场 + 清跳过面板），兑现「旧周期不立即重开」
⑤ engine 单例 v25 → v26（行为变更换血）
"""
import io, sys

def patch(path, pairs):
    with io.open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    for old, new, cnt in pairs:
        n = src.count(old)
        if n != cnt:
            print(f'[FAIL] {path}: anchor x{n} (expect {cnt}): {old[:72]!r}')
            sys.exit(1)
        src = src.replace(old, new, cnt)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'[OK] {path}: {len(pairs)} patch(es)')

AT = 'src/lib/market/trend-trade/auto-trader.ts'
CR = 'src/app/api/trend-trading/control/route.ts'
EN = 'src/lib/market/enhanced/engine.ts'

# ---------- ① auto-trader.ts：新方法（控制操作段头部插入） ----------
patch(AT, [(
"""  // ============ 控制操作（任务 §5.3：开启/暂停/恢复/全部平仓语义分离） ============

  async pause(): Promise<void> {""",
"""  // ============ 控制操作（任务 §5.3：开启/暂停/恢复/全部平仓语义分离） ============

  /**
   * Task 76 清场屏障：等在飞 tick/事件轮结束（最多 8s）后拦住两条循环，返回释放函数。
   * 重置期间 tick()/tickMajorEventEntries() 全部停摆——否则事件循环按旧权益快照在
   * 「清库之后、重置完成之前」的窗口里再开仓，出现重置后凭空多出的持仓。
   * tickStartedAt 同步刷新：防 tick() 的 60s 僵死旁路在屏障期间放行新 tick。
   */
  private async acquireTickBarrier(maxWaitMs = 8_000): Promise<() => void> {
    const deadline = Date.now() + maxWaitMs;
    while ((this.ticking || this.eventTicking) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.ticking = true;
    this.eventTicking = true;
    this.tickStartedAt = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.ticking = false;
      this.eventTicking = false;
    };
  }

  /** Task 76 清场配套：作废全部 ACTIVE 待入场（换持仓数量/切算法后旧周期不立即重开）。返回作废条数 */
  async cancelActivePendings(reason: string): Promise<number> {
    const pendings = await this.repo.loadActivePendings();
    for (const p of pendings) {
      await this.repo.markPendingCanceled(p.cycleId, reason);
      logDecision(`待入场作废 roundKey=${p.cycleId} symbol=${p.symbol} reason=${reason}`);
    }
    return pendings.length;
  }

  /**
   * Task 76：清空内存跳过面板（skips + eventSkips）。「最近跳过」是进程内存列表，
   * 重置/清场类操作不清它——平仓前残留的「已达最大持仓数 N」等旧记录在操作后仍然可见，
   * 用户会误判为「仓位没被清掉」（幽灵记录；DB 决策审计不受影响，照常留痕）。
   */
  clearSkipHistory(): void {
    this.skips = [];
    this.eventSkips.clear();
  }

  async pause(): Promise<void> {""", 1)]
)

# ---------- ② setStrategyId：复用 cancelActivePendings + 清跳过面板 ----------
patch(AT, [(
"""    if (current?.strategyId !== strategyId) {
      // Pending confirmations belong to the old strategy and must not block event-driven entries.
      for (const pending of await this.repo.loadActivePendings()) {
        await this.repo.markPendingCanceled(pending.cycleId, '策略切换：旧算法待入场作废');
      }
    }""",
"""    if (current?.strategyId !== strategyId) {
      // Pending confirmations belong to the old strategy and must not block event-driven entries.
      // Task 76：作废动作收敛到 cancelActivePendings（补决策审计行）；旧算法的跳过面板同步清空
      await this.cancelActivePendings('策略切换：旧算法待入场作废');
      this.clearSkipHistory();
    }""", 1)]
)

# ---------- ③ resetAccount：屏障包裹 + 跳过面板清空 + 注释补 ⑥⑦ ----------
patch(AT, [(
"""   * ④ 余额 = initialCapital（100）、totalDeposited = 0（ROI 本金基准 = initialCapital +
   *    totalDeposited，回到 100）、权益峰值归零；
   * ⑤ 运行模式与持仓数量等配置保持不变。手动盘 default 账户完全不受影响。
   */
  async resetAccount(): Promise<{ closed: number }> {
    const r = await this.closeAllManual();
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (acc) {
      await db.paperPosition.deleteMany({ where: { accountId: acc.id } });
      await db.paperTrade.deleteMany({ where: { accountId: acc.id } });
    }
    await db.$executeRawUnsafe(`DELETE FROM TrendTradeMeta`);
    await db.$executeRawUnsafe(`DELETE FROM TrendAutoDecision`);
    await db.$executeRawUnsafe(`DELETE FROM TrendPendingEntry`);
    await db.$executeRawUnsafe(`DELETE FROM TrendStrategyState`); // Task 57：轮次状态一并归零
    this.strategy.importState({}); // 内存策略状态同步清空（重置后同周期按首次开仓处理）
    const cfg = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    const capital = cfg?.initialCapital ?? TREND_TRADE.INITIAL_CAPITAL;
    if (acc) {
      await db.paperAccount.update({
        where: { id: acc.id },
        data: { balance: capital, totalDeposited: 0 },
      });
    }
    await this.repo.resetPeakEquity(TREND_TRADE.ACCOUNT_NAME);
    return { closed: r.closed };
  }""",
"""   * ④ 余额 = initialCapital（100）、totalDeposited = 0（ROI 本金基准 = initialCapital +
   *    totalDeposited，回到 100）、权益峰值归零；
   * ⑤ 运行模式与持仓数量等配置保持不变。手动盘 default 账户完全不受影响。
   * ⑥ Task 76：全程持清场屏障（等在飞 tick/事件轮结束并拦住新 tick）——事件循环按旧
   *    权益快照在清库后开仓的竞争窗口归零，重置后不会凭空多出持仓；
   * ⑦ Task 76：内存跳过面板同步清空——平仓前「已达最大持仓数」等旧记录不得残留
   *    （用户据幽灵记录误判「重置没清掉持仓」的根因）。
   */
  async resetAccount(): Promise<{ closed: number }> {
    const release = await this.acquireTickBarrier();
    try {
      const r = await this.closeAllManual();
      const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
      if (acc) {
        await db.paperPosition.deleteMany({ where: { accountId: acc.id } });
        await db.paperTrade.deleteMany({ where: { accountId: acc.id } });
      }
      await db.$executeRawUnsafe(`DELETE FROM TrendTradeMeta`);
      await db.$executeRawUnsafe(`DELETE FROM TrendAutoDecision`);
      await db.$executeRawUnsafe(`DELETE FROM TrendPendingEntry`);
      await db.$executeRawUnsafe(`DELETE FROM TrendStrategyState`); // Task 57：轮次状态一并归零
      this.strategy.importState({}); // 内存策略状态同步清空（重置后同周期按首次开仓处理）
      this.clearSkipHistory(); // Task 76：跳过面板同步清空（幽灵记录不跨清场残留）
      const cfg = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
      const capital = cfg?.initialCapital ?? TREND_TRADE.INITIAL_CAPITAL;
      if (acc) {
        await db.paperAccount.update({
          where: { id: acc.id },
          data: { balance: capital, totalDeposited: 0 },
        });
      }
      await this.repo.resetPeakEquity(TREND_TRADE.ACCOUNT_NAME);
      return { closed: r.closed };
    } finally {
      release();
    }
  }""", 1)]
)

# ---------- ④ control/route.ts：setMaxPositions 清场三件套 + 注释 ----------
patch(CR, [
# 文档头
(""" * - setMaxPositions：设置持仓数量/最大同时持仓数（Task 55：可选；更换时自动平仓
 *   原有持仓。Task 56 sizing：每仓保证金 = 开仓时账户权益 × 20%，与持仓数量解耦，
 *   持仓数量仅约束同时持仓上限）""",
""" * - setMaxPositions：设置持仓数量/最大同时持仓数（Task 55：可选；更换时清场——自动平仓
 *   原有持仓 + 作废待入场 + 清空跳过面板（Task 76）。Task 56 sizing：每仓保证金 =
 *   开仓时账户权益 × 20%，与持仓数量解耦，持仓数量仅约束同时持仓上限）""", 1),
# 动作注释 + 执行体
("""      // Task 55：可选持仓数量（最大同时持仓数）——更换时自动平仓原有持仓（用户定版：
      // 旧仓按旧口径开出，换数量即清场，新仓按新数量均分开仓）。同值不动作。""",
"""      // Task 55：可选持仓数量（最大同时持仓数）——更换时自动平仓原有持仓（用户定版：
      // 旧仓按旧口径开出，换数量即清场，新仓按新数量均分开仓）。同值不动作。
      // Task 76：清场三件套——平仓之外同步作废全部待入场（否则旧周期待入场继续占容量槽，
      // 新信号被「已达最大持仓数」误拒、甚至冷却=0 时旧周期直接重开）并清空跳过面板
      // （平仓前残留的「已达最大持仓数」旧记录不跨清场显示）。""", 1),
("""        // 先自动平仓原有持仓（先平后开：被平仓的旧趋势周期不会立即重开，新仓只来自新确认周期）
        const closed = await engine.autoTrader.closeAllManual();
        await trendTradeRepo.updateMaxPositions(TREND_TRADE.ACCOUNT_NAME, value);""",
"""        // 先自动平仓原有持仓（先平后开：被平仓的旧趋势周期不会立即重开，新仓只来自新确认周期）
        const closed = await engine.autoTrader.closeAllManual();
        const canceled = await engine.autoTrader.cancelActivePendings('切换持仓数量清场：待入场作废');
        engine.autoTrader.clearSkipHistory();
        await trendTradeRepo.updateMaxPositions(TREND_TRADE.ACCOUNT_NAME, value);""", 1),
# note 文案带上作废条数
("""          note: `持仓数量已设为 ${value}；已自动平仓 ${closed.closed} 笔原持仓${
            closed.skipped > 0 ? `（${closed.skipped} 笔暂时未能平仓，将在下轮巡检重试）` : ''
          }。每仓保证金 = 开仓时权益 × min(设定比例 ${(setRatio * 100).toFixed(0)}%， 95%÷${value}舱) = ${effPct}%权益（按舱位数划分：1 舱满配 95%、N 舱各 95%/N，先开仓不挤占后舱，Task 67）；余额不足仍跳过并记录`,""",
"""          note: `持仓数量已设为 ${value}；已自动平仓 ${closed.closed} 笔原持仓、作废 ${canceled} 条待入场${
            closed.skipped > 0 ? `（${closed.skipped} 笔暂时未能平仓，将在下轮巡检重试）` : ''
          }。每仓保证金 = 开仓时权益 × min(设定比例 ${(setRatio * 100).toFixed(0)}%， 95%÷${value}舱) = ${effPct}%权益（按舱位数划分：1 舱满配 95%、N 舱各 95%/N，先开仓不挤占后舱，Task 67）；余额不足仍跳过并记录`,""", 1)]
)

# ---------- ⑤ engine.ts：单例 v25 → v26 ----------
patch(EN, [
("""  __binanceRadarEnhanced_v25?: EnhancedEngine; // v25（Task 75）：反向跟随（executeOpen 执行侧翻转）""",
"""  __binanceRadarEnhanced_v25?: EnhancedEngine; // v25（Task 75）：反向跟随（executeOpen 执行侧翻转）
  __binanceRadarEnhanced_v26?: EnhancedEngine; // v26（Task 76）：重置清场屏障 + 跳过面板清空 + 换仓数作废待入场""", 1),
("""    __binanceRadarEnhanced_v25?: EnhancedEngine;
  }""",
"""    __binanceRadarEnhanced_v25?: EnhancedEngine;
    __binanceRadarEnhanced_v26?: EnhancedEngine;
  }""", 1),
("""  return (
    g.__binanceRadarEnhanced_v25 ??""",
"""  return (
    g.__binanceRadarEnhanced_v26 ??
    g.__binanceRadarEnhanced_v25 ??""", 1),
("""  const existing = g.__binanceRadarEnhanced_v25;""",
"""  const existing = g.__binanceRadarEnhanced_v26;""", 1),
("""  g.__binanceRadarEnhanced_v25 = fresh;""",
"""  g.__binanceRadarEnhanced_v26 = fresh;""", 2),
("""  const old = g.__binanceRadarEnhanced_v25 ?? pickLegacyEngine(g);""",
"""  const old = g.__binanceRadarEnhanced_v26 ?? pickLegacyEngine(g);""", 1)]
)

print('ALL PATCHES APPLIED')
