// ---------- AutoPaperTrader：趋势自动模拟交易服务（Task 54 §3/§四 / Task 56 用户定版） ----------
// 消费 TrendWatchService 输出的统一趋势信号（UnifiedTrendSignal，单一趋势来源——
// 本服务绝不另行计算趋势方向），按固定规则开仓/持仓/平仓；纯模拟，不接入真实下单。
//
// 交易规则（Task 56 用户定版）：
// - 独立账户 trend-auto-v1（PaperAccount.name 隔离；手动 default 盘完全不受影响）
// - 开仓：确认趋势（CONFIRMED_UP/DOWN）+ 策略门槛（短周期套利：score/ER/5m 分级/追入
//   保护/新鲜窗；通用趋势引擎：方向选择确认制）+ 二次确认
//   （首次确认只建待入场记录，等下一根已收盘 K 线复核后开仓）+ 同币种冷却（默认 5 分钟，
//   控制台可调，运行库当前为 0 = 用户关闭）；
//   每仓保证金 = 开仓时账户权益 × min(marginRatio 上限, 95%÷配置舱位数)（Task 67 舱位划分：
//   选 1 舱单仓满配 95% 开最大仓，选 N 舱各 95%/N，先开仓不挤占后开舱；Task 65 动态版按
//   (当前持仓数+1) 均分，首仓永远吃满 95%、后舱无仓可开——用户复盘废弃），杠杆固定 20x；
//   保证金+手续费超出可用余额直接跳过并记录（不变相提高比例/杠杆）；
//   同一趋势周期只允许一笔（决策键幂等），不允许加仓摊平
// - 离场（Task 66 复盘定版）：基础设施硬规则不变——ENDED（连续 END_CONFIRM_BARS 根独立
//   证据且周期匹配 + 证据 K 线晚于开仓 K 线）/反向确认（dataFresh）/强平照旧；在此之上
//   策略层表达个性离场：短周期套利 = 冲高落袋 + 走弱先走；通用趋势引擎 = 硬止损
//   （STOP_LOSS，价格逆行超限）+ 移动止盈（TRAIL_TAKE，峰值浮盈后回撤超限落袋）+
//   走弱先走（WEAKNESS_EARLY，证据达标版）。END_PENDING 仍只记录首次报警时刻，
//   是否提前离场由当前策略决定
// - 数据不可用（DATA_UNAVAILABLE/过期）：不新开仓、不伪装趋势结束、继续按标记价
//   管理强平；暂停模式：只停新开仓（含待入场转换），继续退出管理与强平巡检
// - 成本口径：开/平仓手续费双边各 0.02%（Task 59 用户定版，TREND_TRADE.FEE_RATE；
//   经 PaperEngine 实例属性 feeRate 生效——手动盘 default 账户仍为默认 Taker 0.05%）；
//   滑点按可配基点估算，成交记录展示；统计主口径 = 含滑点净盈亏（更保守，不省略成本）
// - 持仓结果采集（Task 56 §七）：MFE/MAE 按主循环可用标记价增量更新并持久化，
//   绝不用事后最高/最低价构造决策时不存在的数据
// - 成交假设：以决策时刻标记价成交（非信号 K 线收盘价），绝不使用未来行情
//
// 生命周期：绑定 EnhancedEngine（boot 拉起 / stop 停表）；单例由引擎单例保证；
// 重启后从 DB 恢复持仓关联（TrendTradeMeta）、待入场记录（TrendPendingEntry）并 reconcile。

import { db } from '@/lib/db';
import { PaperError, PaperEngine, paperEngineFor } from '../paper';
import type { UnifiedTrendSignal } from '../trend-watch/signal';
import type { EnhancedEventDTO } from '../enhanced/types';
import type { Candle1m } from '../enhanced/klines';
import { TREND_WATCH } from '../trend-watch/config';
import {
  TREND_TRADE,
  effectiveMarginRatio,
  type HtfGateState,
  type TrendAutoMode,
  type TrendExitReason,
} from './config';
import {
  createTrendTradeRepo,
  ensureTrendTradeSchema,
  type TrendAutoConfigRow,
  type TrendPendingEntryRow,
  type TrendTradeMetaRow,
  type TrendTradeRepo,
} from './repo';
import { createStrategy, DEFAULT_STRATEGY_ID, isKnownStrategy } from './strategy/registry';
import type { StrategyEntryVerdict, StrategyMajorEventEntryVerdict, StrategyMarketCtx, TrendStrategy } from './strategy/types';
import { parseStrategyParamsMap, sanitizeRuntimeParamsLenient } from './console-params';

export interface AutoTraderDeps {
  /** 统一趋势信号（trendWatch.latestSignals——唯一趋势来源） */
  getSignals(): UnifiedTrendSignal[];
  /** 标记价（合约多源供价） */
  markPrice(symbol: string): number;
  /** Active anomaly events for algorithms independent of the trend pool. */
  getActiveEvents?(now: number): EnhancedEventDTO[];
  /** Recent closed 1m bars for structure classification; no network I/O here. */
  getCandles?(symbol: string, lookbackMs: number, now: number): Candle1m[];
  /** 24h quote-volume snapshot for the liquidity filter. */
  quoteVolume24h?(symbol: string): number;
}

interface SkipRecord {
  t: number;
  symbol: string;
  reason: string;
  cycleId?: string;
}

const MAJOR_EVENT_SCAN_MS = 1_000;

function floor2(v: number): number {
  return Math.floor((v + 1e-9) * 100) / 100;
}

function isTransientOpenError(e: unknown): boolean {
  if (!(e instanceof PaperError)) return false;
  // 行情未就绪/未知交易对 = 暂时性（下轮重试）；保证金/上限类 = 永久跳过
  return e.message.includes('行情') || e.message.includes('未知交易对');
}

/** 结构化决策日志（§2.4：可还原一次误平仓/误开仓的完整过程） */
function logDecision(msg: string): void {
  console.log(`[trend-auto] ${msg}`);
}

/** 高周期方向分级（快照留档用：与 1m 趋势方向比较） */
function classifyHtf(
  dir: 'up' | 'down' | 'flat',
  valid: boolean,
  trendDir: 'up' | 'down',
): HtfGateState {
  if (!valid) return 'INVALID';
  if (dir === trendDir) return 'ALIGNED';
  if (dir === 'flat') return 'NEUTRAL';
  return 'OPPOSED';
}

/** 待入场/决策幂等键的轮次化：`{cycleId}#R{round}`（Task 57：同周期多轮开仓） */
function roundKey(cycleId: string, round: number): string {
  return `${cycleId}#R${round}`;
}

/** 从轮次化键取回纯周期 id（持仓关联/周期匹配仍用纯 cycleId） */
function baseCycleOf(key: string): string {
  const i = key.indexOf('#');
  return i > 0 ? key.slice(0, i) : key;
}

/** 从轮次化键解析轮次号（`{cycleId}#R{n}` → n；无轮次后缀按 1） */
function pendingRoundOf(key: string): number {
  const m = key.match(/#R(\d+)$/);
  return m ? Number(m[1]) : 1;
}

/** 同币种冷却时长：DB 列优先（控制台可调），缺省用代码常量 */
function cooldownOf(cfg: TrendAutoConfigRow): number {
  return cfg.cooldownMs ?? TREND_TRADE.COOLDOWN_MS;
}

export class AutoPaperTrader {
  private readonly deps: AutoTraderDeps;
  private readonly repo: TrendTradeRepo;
  private readonly engine: PaperEngine;
  /** 当前交易策略（Task 57 可插拔；boot 按 DB 配置装配，运行期可切换） */
  private strategy: TrendStrategy;
  /** 外部固定注入的策略（测试/定制用）：boot/tick 不按 DB 配置覆盖 */
  private readonly fixedStrategy: boolean;
  /** Task 82：配置算法无法装配时的失配标记（值 = 装配失败的 strategyId；null = 无失配）。
   * 场景：进程早于算法上线启动（旧注册表不认识新 id）→ createStrategy 会静默兜底默认算法，
   * 形成「DB 配置 A、实际运行 B」的隐形错配（UI 读 DB 显示已切换、交易却按旧算法执行）。
   * 此标记驱动 fail-safe：保留当前实例、暂停新开仓、lastError 持续暴露，直至服务重启
   * 装配新注册表后自愈。 */
  private strategyDesync: string | null = null;

  private started = false;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  /** 引擎启动时刻（engine.stats 摘要用；0 = 未启动） */
  startedAt = 0;
  private lastTickAt = 0;
  private lastError: string | null = null;
  /** Task 78：readonly 自愈去重（断开→惰性重连窗口期内不重复触发） */
  private readonlyHealing = false;

  /** 跳过记录（内存审计；接口可见最近 50 条） */
  private skips: SkipRecord[] = [];
  /** Task 72：事件路径拒绝去重（eventId → 最近原因/时刻）；同因 60s 一条，原因变化立即记 */
  private eventSkips = new Map<string, { reason: string; at: number }>();
  opens = 0;
  closes = 0;

  constructor(
    deps: AutoTraderDeps,
    opts?: { repo?: TrendTradeRepo; engine?: PaperEngine; noTimer?: boolean; strategy?: TrendStrategy },
  ) {
    this.deps = deps;
    this.repo = opts?.repo ?? createTrendTradeRepo();
    this.engine = opts?.engine ?? paperEngineFor(TREND_TRADE.ACCOUNT_NAME, TREND_TRADE.FEE_RATE);
    this.strategy = opts?.strategy ?? createStrategy(TREND_TRADE.DEFAULT_STRATEGY_ID);
    // 外部注入的策略（测试/定制）优先：boot 不按 DB 配置覆盖，tick 自愈也不改换
    this.fixedStrategy = opts?.strategy != null;
    this.noTimer = opts?.noTimer ?? false;
  }

  private readonly noTimer: boolean;

  // ============ 生命周期 ============

  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) {
      await Promise.race([this.starting, new Promise((r) => setTimeout(r, 6000))]);
      return;
    }
    this.started = true;
    this.stopped = false;
    this.startedAt = Date.now();
    this.starting = this.boot().finally(() => {
      this.starting = null;
    });
    await Promise.race([this.starting, new Promise((r) => setTimeout(r, 6000))]);
  }

  private async boot(): Promise<void> {
    // 1) 建表（幂等，含 Task 56 扩展列/待入场表）+ 播种配置 + 独立账户初始化
    await ensureTrendTradeSchema();
    const seeded = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    if (!seeded) {
      await this.repo.seedConfig({
        name: TREND_TRADE.ACCOUNT_NAME,
        mode: 'RUNNING',
        initialCapital: TREND_TRADE.INITIAL_CAPITAL,
        marginRatio: TREND_TRADE.MARGIN_RATIO,
        leverage: TREND_TRADE.LEVERAGE,
        maxPositions: TREND_TRADE.MAX_POSITIONS,
        slippageBps: TREND_TRADE.SLIPPAGE_BPS,
        peakEquity: 0,
      });
    }
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (!acc) {
      await db.paperAccount.create({
        data: { name: TREND_TRADE.ACCOUNT_NAME, balance: TREND_TRADE.INITIAL_CAPITAL },
      });
    }
    // 2) 装配策略（Task 57：DB 配置的 strategyId + 恢复策略轮次状态；外部注入的固定策略不覆盖）
    if (!this.fixedStrategy) {
      const cfgNow = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
      await this.applyStrategy(cfgNow?.strategyId ?? TREND_TRADE.DEFAULT_STRATEGY_ID);
    } else {
      this.strategy.bindPersistence((sid, sym, json) => {
        void this.repo.saveStrategyState(sid, sym, json).catch(() => {});
      });
    }
    // 3) reconcile：修复崩溃窗口（开仓成功但 meta 未写 / 平仓成功但 meta 未关）
    await this.reconcile();
    // 4) 主循环（独立持续风险检查任务：无页面访问也照常巡检强平与管理持仓）
    if (!this.noTimer) {
      this.timer = setInterval(() => void this.tick(), TREND_TRADE.SCAN_MS);
      // EnhancedEngine detects market events every 2s; run the dedicated event strategy every 1s.
      this.eventTimer = setInterval(() => void this.tickMajorEventEntries(), MAJOR_EVENT_SCAN_MS);
    }
  }

  /**
   * 装配策略实例（boot / 运行期切换 / tick 自愈 / 控制台调参后共用）：创建实例（带 DB
   * 参数覆盖——Task 57-c 控制台）、绑定状态持久化、从 TrendStrategyState 恢复轮次状态。
   * 参数解析失败（脏数据）回退代码默认，绝不阻断交易循环。
   */
  private async applyStrategy(strategyId: string): Promise<void> {
    // Task 82 fail-safe：未知算法拒绝装配（绝不静默兜底）。兜底会制造「配置 A 实际 B」的
    // 隐形错配——UI 读 DB 显示 A、交易却按 B 执行，比停开新仓危险得多。保留当前实例 +
    // 置失配标记：新开仓暂停、错误持续可见，等进程重启后新注册表生效（boot 按 DB 配置装配）。
    if (!isKnownStrategy(strategyId)) {
      if (this.strategyDesync !== strategyId) {
        this.strategyDesync = strategyId;
        logDecision(
          `拒绝装配未知算法 ${strategyId}（本进程注册表没有该 id，服务可能早于算法上线启动）；` +
            `保留当前实例 ${this.strategy.id}，新开仓已暂停，请重启服务使新算法生效`,
        );
      }
      return;
    }
    this.strategyDesync = null;
    let params: Record<string, unknown> | undefined;
    try {
      const cfgNow = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
      const raw = parseStrategyParamsMap(cfgNow?.strategyParamsJson)[strategyId];
      if (raw && typeof raw === 'object') {
        // Task 62：宽松校验按当前算法过滤——strategy 域键只保留归属当前 strategyId 的
        // （跨策略遗留键丢弃回默认），infra 键照常收敛
        params = sanitizeRuntimeParamsLenient(raw, strategyId).strategyParams;
      }
    } catch {
      params = undefined; // 配置读取失败回退代码默认
    }
    const s = createStrategy(strategyId, params);
    s.bindPersistence((sid, sym, json) => {
      void this.repo.saveStrategyState(sid, sym, json).catch(() => {
        // 状态持久化失败不影响决策（重启后轮次可能回退一档，可接受）
      });
    });
    try {
      s.importState(await this.repo.loadStrategyStates(s.id));
    } catch {
      // 恢复失败从空状态开始（轮次按首次处理，保守不丢单）
    }
    this.strategy = s;
  }

  /**
   * 切换交易算法（Task 57 UI 入口）：持久化 strategyId + 装配新实例。
   * 持仓清场由调用方（control API）先执行——不同算法持仓管理规则不同，不混管。
   */
  async setStrategyId(strategyId: string): Promise<void> {
    // Task 82：切换前先确认本进程真能装配该算法——否则 DB 写入成功、实例装配静默兜底，
    // 用户看到「已切换」实际仍在跑旧算法（strong-trend-v1 上线当晚的实测故障：control 路由
    // 的 isKnownStrategy 用的是路由自己的模块图，HMR 后是新的，验不了本单例的旧注册表；
    // 必须在实例这边——与装配同一模块图——再验一次）。
    if (!isKnownStrategy(strategyId)) {
      throw new Error(
        `算法 ${strategyId} 未在当前进程注册（服务可能早于该算法上线启动），已拒绝切换。` +
          `请重启服务后重试；重启后 boot 会按 DB 配置自动装配该算法`,
      );
    }
    const current = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
    if (current?.strategyId !== strategyId) {
      // Pending confirmations belong to the old strategy and must not block event-driven entries.
      // Task 76：作废动作收敛到 cancelActivePendings（补决策审计行）；旧算法的跳过面板同步清空
      await this.cancelActivePendings('策略切换：旧算法待入场作废');
      this.clearSkipHistory();
    }
    await this.repo.updateStrategyId(TREND_TRADE.ACCOUNT_NAME, strategyId);
    await this.applyStrategy(strategyId);
  }

  // ============ 参数控制台（Task 57-c：用户可自行调整自动开仓参数） ============

  /**
   * 保存运行时参数（控制台「保存」入口）并热生效：
   * - strategyParams：当前策略的覆盖项（整体替换该 strategyId 的覆盖对象；传 {} = 全回默认）；
   *   非固定注入策略时重装配实例（轮次状态从 DB 恢复，语义不丢）。
   * - waitBarConfirm / cooldownMs / marginRatio：基础设施参数，auto-trader 每 tick 重读
   *   配置，下一 tick 生效（marginRatio 实际比例 = min(设定值, 95%÷配置舱位数)，见 config.ts）。
   * 入参已在 control API 层严格校验（白名单 + 范围）。
   */
  async setRuntimeParams(patch: {
    strategyParams?: Record<string, unknown>;
    waitBarConfirm?: number;
    cooldownMs?: number;
    marginRatio?: number;
    reverseMode?: number;
  }): Promise<void> {
    const name = TREND_TRADE.ACCOUNT_NAME;
    const cfg = await this.repo.loadConfig(name);
    const strategyId = cfg?.strategyId ?? TREND_TRADE.DEFAULT_STRATEGY_ID;
    const dbPatch: {
      strategyParamsJson?: string | null;
      waitBarConfirm?: number;
      cooldownMs?: number | null;
      marginRatio?: number;
      reverseMode?: number;
    } = {};
    let strategyChanged = false;
    if (patch.strategyParams !== undefined) {
      const map = parseStrategyParamsMap(cfg?.strategyParamsJson);
      map[strategyId] = patch.strategyParams;
      dbPatch.strategyParamsJson = JSON.stringify(map);
      strategyChanged = true;
    }
    if (patch.waitBarConfirm !== undefined) dbPatch.waitBarConfirm = patch.waitBarConfirm;
    if (patch.cooldownMs !== undefined) dbPatch.cooldownMs = patch.cooldownMs;
    if (patch.marginRatio !== undefined) dbPatch.marginRatio = patch.marginRatio;
    if (patch.reverseMode !== undefined) dbPatch.reverseMode = patch.reverseMode;
    if (Object.keys(dbPatch).length === 0) return;
    await this.repo.updateRuntimeParams(name, dbPatch);
    if (strategyChanged && !this.fixedStrategy) {
      await this.applyStrategy(strategyId); // 热装配：新参数立即用于后续评估；轮次状态从 DB 恢复
      logDecision(`参数控制台：策略参数已更新并热应用（strategy=${strategyId} params=${JSON.stringify(patch.strategyParams)}）`);
    }
    // marginRatio 为基础设施列：每 tick 重读 cfg，下一 tick 生效（无需重装配）
    if (patch.marginRatio !== undefined) {
      logDecision(`参数控制台：每仓保证金比例已更新为 ${patch.marginRatio}（下一 tick 生效；实际比例 = min(设定值, 95%÷配置舱位数)）`);
    }
    // Task 75：反向跟随为基础设施列，每 tick 重读 cfg，下一 tick 生效
    if (patch.reverseMode !== undefined) {
      logDecision(
        `参数控制台：反向跟随已${patch.reverseMode === 1 ? '开启（全部算法开仓方向取反执行；平仓仍跟随模型：模型止损=我们止盈、模型止盈=我们止损）' : '关闭（恢复正常跟随）'}（下一 tick 生效）`,
      );
    }
  }

  /**
   * 恢复全部控制台参数为代码默认（控制台「恢复默认」入口）：
   * 清除当前策略的参数覆盖 + 二次确认开关回开 + 冷却回默认 + 保证金比例回 20%；轮次状态保留。
   */
  async resetRuntimeParams(): Promise<void> {
    const name = TREND_TRADE.ACCOUNT_NAME;
    const cfg = await this.repo.loadConfig(name);
    const strategyId = cfg?.strategyId ?? TREND_TRADE.DEFAULT_STRATEGY_ID;
    const map = parseStrategyParamsMap(cfg?.strategyParamsJson);
    delete map[strategyId];
    await this.repo.updateRuntimeParams(name, {
      strategyParamsJson: JSON.stringify(map),
      waitBarConfirm: 1,
      cooldownMs: null,
      marginRatio: TREND_TRADE.MARGIN_RATIO, // 列 NOT NULL，回默认值而非 null
      reverseMode: 0, // Task 75：反向跟随回关（正常跟随为默认）
    });
    if (!this.fixedStrategy) {
      await this.applyStrategy(strategyId);
      logDecision(`参数控制台：已恢复全部参数为代码默认（strategy=${strategyId}）`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.timer = null;
    this.eventTimer = null;
  }

  /**
   * 崩溃窗口修复（任务 §七：服务重启后必须恢复持仓关联信息）：
   * a) 自动账户 OPEN 持仓缺 TrendTradeMeta → 从最近一条已抢占未绑定的 OPEN 决策恢复
   *    cycleId；找不到则标 ORPHAN 周期（保守：只受强平/人工/反向确认管理——ORPHAN 周期
   *    无从与 ENDED 事件做周期匹配，按 §2.2 不再「仅凭 symbol」离场）。
   * b) meta OPEN 但 PaperPosition 已 CLOSED/LIQUIDATED → 补写平仓终态。
   */
  private async reconcile(): Promise<void> {
    try {
      const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
      if (!acc) return;
      const openPositions = await db.paperPosition.findMany({
        where: { accountId: acc.id, status: 'OPEN' },
      });
      for (const p of openPositions) {
        const meta = await this.repo.getMeta(p.id);
        if (!meta) {
          const claimed = await db.$queryRawUnsafe<{ cycleId: string; createdAt: Date }[]>(
            `SELECT cycleId, createdAt FROM TrendAutoDecision
             WHERE symbol = ? AND action = 'OPEN' AND positionId IS NULL
             ORDER BY createdAt DESC LIMIT 1`,
            p.symbol,
          );
          const cycleId = claimed[0]?.cycleId ?? `ORPHAN:${p.symbol}:${p.openedAt.getTime()}`;
          await this.repo.upsertMeta({
            positionId: p.id,
            trendCycleId: cycleId,
            symbol: p.symbol,
            side: p.side,
            trendPhaseAtOpen: 'CONFIRMED_RESTORED',
            scoreAtOpen: 0,
            featuresAtOpen: JSON.stringify({ restored: true, recoveredAt: Date.now() }),
            signalAtOpen: '{}',
            slippageEst: p.qty * p.entryPrice * (TREND_TRADE.SLIPPAGE_BPS / 10_000),
            status: 'OPEN',
            exitReason: null,
            exitSignalJson: null,
            netPnlWithSlip: null,
            openDecisionAt: claimed[0]?.createdAt ?? p.openedAt,
            closedAt: null,
          });
        }
      }
      // meta OPEN 但仓位已终态 → 补写
      const openMetas = await this.repo.loadMetasByStatus('OPEN');
      for (const m of openMetas) {
        const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
        if (!pos) {
          await this.repo.upsertMeta({ ...m, status: 'CLOSED', exitReason: 'MANUAL', closedAt: new Date() });
          continue;
        }
        if (pos.status === 'LIQUIDATED') {
          await this.finalizeLiquidated(m, pos.margin, pos.pnl ?? -pos.margin);
        } else if (pos.status === 'CLOSED') {
          await this.repo.upsertMeta({
            ...m,
            status: 'CLOSED',
            exitReason: 'MANUAL',
            netPnlWithSlip: (pos.pnl ?? 0) - m.slippageEst,
            closedAt: pos.closedAt ?? new Date(),
          });
        }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] reconcile 失败：', this.lastError);
      void this.selfHealIfReadonly(e);
    }
  }

  // ============ 主循环 ============

  /** 单步主循环：public 以便测试/回放驱动（生产由 SCAN_MS 定时器调用） */
  // 重入保护：setInterval 不等待异步完成——上一轮 tick 未跑完（行情/DB 慢）时下一轮并发
  // 执行，会按同一份旧余额重复开仓。60s 僵死兜底：异常挂起时不永久卡死主循环。
  private ticking = false;
  private tickStartedAt = 0;
  private eventTicking = false;

  async tick(): Promise<void> {
    if (this.stopped || this.eventTicking) return;
    if (this.ticking && Date.now() - this.tickStartedAt < 60_000) return;
    this.ticking = true;
    this.tickStartedAt = Date.now();
    try {
      const now = Date.now();
      this.lastTickAt = now;
      const cfg = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
      if (!cfg) return;
      const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
      if (!acc) return;
      const accId = acc.id;

      // ① 持续风险巡检（任何模式都执行——强平不因暂停/数据不可用而缺席）
      await this.engine.liquidationCheck(accId);
      await this.finalizeNewLiquidations();

      // ② 持仓结果采集（§七：MFE/MAE 按当前可用标记价增量更新——任何模式都执行）
      await this.updateOpenStats();

      // ②b 策略自愈：DB 配置的算法与实例不一致（如 control 已写库但实例切换失败）→ 重新装配。
      // Task 82：装配失败（未知算法）时 applyStrategy 内部置 desync 且只记一次拒绝日志；
      // 这里只在「真正换上了」时记自愈日志——避免失配死循环每 tick 刷屏（曾实测 10 分钟 62 条）
      if (!this.fixedStrategy && cfg.strategyId && cfg.strategyId !== this.strategy.id) {
        await this.applyStrategy(cfg.strategyId);
        if (this.strategy.id === cfg.strategyId) logDecision(`策略自愈切换 → ${cfg.strategyId}`);
      }

      // ③ 退出管理（暂停模式也执行：趋势结束/反向确认/策略离场照常执行）
      const signals = this.deps.getSignals();
      const bySymbol = new Map(signals.map((s) => [s.symbol, s]));
      await this.manageExits(bySymbol);

      // ③b 策略行情采样（冲高检测等需要短窗价格序列；只喂当时可用的标记价）
      for (const s of signals) {
        const mark = this.deps.markPrice(s.symbol);
        if (mark > 0) this.strategy.observe(s.symbol, mark, now);
      }
      for (const meta of await this.repo.loadMetasByStatus('OPEN')) {
        const mark = this.deps.markPrice(meta.symbol);
        if (mark > 0) this.strategy.observe(meta.symbol, mark, now);
      }

      // ④ 权益峰值（回撤基准；任何模式都更新）
      const eq = await this.accountEquity(accId);
      if (eq.equity > cfg.peakEquity) {
        await this.repo.updatePeakEquity(TREND_TRADE.ACCOUNT_NAME, eq.equity);
      }

      // ⑤ 开仓（仅 RUNNING 且数据新鲜；暂停/停止只停新开仓与待入场转换）。
      // Task 82：算法失配（配置的算法装配不了）时同样停开新仓——fail-safe：宁可不开，
      // 也不能用错算法交易；退出管理与强平巡检照常（持仓安全优先）。
      if (cfg.mode === 'RUNNING' && !this.strategy.eventDriven && !this.strategyDesync) {
        await this.managePendings(bySymbol, cfg, eq); // 先转换已到期的待入场（等一根 K 线复核）
        await this.manageEntries(cfg, signals, eq); // 再为策略想开仓的趋势创建待入场记录
      }
      // Task 82：失配时持续把原因暴露到 service.lastError（总览「最近错误」展示），
      // 而不是成功路径一律清空——用户必须能看到「配置的算法没在真正运行」
      this.lastError = this.strategyDesync
        ? `配置算法 ${this.strategyDesync} 未在当前进程注册，新开仓已暂停（实际运行 ${this.strategy.id}）；请重启服务使新算法生效`
        : null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] tick 失败：', this.lastError);
      void this.selfHealIfReadonly(e);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Low-latency event loop. It bypasses trend-pool entry, UTE confirmation, pending-bar confirmation,
   * and generic cooldown. Shared PaperEngine execution still owns position/funds/fees/slippage/idempotency.
   */
  async tickMajorEventEntries(): Promise<void> {
    const strategy = this.strategy;
    const evaluateMajorEventEntry = strategy.evaluateMajorEventEntry?.bind(strategy);
    const getActiveEvents = this.deps.getActiveEvents?.bind(this.deps);
    const getCandles = this.deps.getCandles?.bind(this.deps);
    if (
      this.stopped ||
      this.ticking ||
      this.eventTicking ||
      !strategy.eventDriven ||
      !evaluateMajorEventEntry ||
      !getActiveEvents ||
      !getCandles
    ) return;

    this.eventTicking = true;
    try {
      const now = Date.now();
      const cfg = await this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME);
      if (!cfg || cfg.strategyId !== strategy.id) return;

      const accId = await this.autoAccountId();
      // Exits and liquidation continue even when entries are paused.
      await this.engine.liquidationCheck(accId);
      await this.finalizeNewLiquidations();
      await this.updateOpenStats();
      await this.manageExits(new Map());

      if (cfg.mode !== 'RUNNING' || this.strategy !== strategy) return;

      const candidates = getActiveEvents(now)
        .filter((event) =>
          event.state === 'ACTIVE' &&
          event.level === 'MAJOR' &&
          (event.priority === 'P1' || (event.peakPriority === 'P1' && event.breakout.status === 'FALSE'))
        )
        .sort((a, b) => (b.p1At ?? b.updatedAt) - (a.p1At ?? a.updatedAt));
      if (candidates.length === 0) return;

      const eq = await this.accountEquity(accId);
      const openRows = await db.paperPosition.findMany({ where: { accountId: accId, status: 'OPEN' } });
      const openSymbols = new Set(openRows.map((position) => position.symbol));

      for (const event of candidates) {
        if (this.strategy !== strategy || this.strategy.id !== cfg.strategyId) return;
        if (eq.openCount >= cfg.maxPositions) break;
        if (openSymbols.has(event.symbol)) continue;

        const mark = this.deps.markPrice(event.symbol);
        if (!(mark > 0)) continue;
        const quoteVolume24h = this.deps.quoteVolume24h?.(event.symbol) ?? 0;
        const candles = getCandles(event.symbol, 45 * 60_000, now);
        const lastClose = await this.repo.lastCloseAt(event.symbol);
        const ctx = this.strategyCtx(now, mark, cfg, eq, openSymbols, lastClose);
        const eventVerdict = evaluateMajorEventEntry({ event, candles, quoteVolume24h, ctx });
        if (!eventVerdict || !eventVerdict.want || !eventVerdict.side) {
          // Task 72：事件路径拒绝不再静默——原因进「最近跳过」（与信号路径「策略不入场」同语义；
          // 事件循环 1s 一跑，同一事件同一原因会反复评估，60s 节流防刷屏）
          this.recordEventSkip(event, `策略不入场：${eventVerdict?.reason ?? '事件未通过策略门槛'}`);
          continue;
        }

        const rKey = roundKey(eventVerdict.eventCycleId, strategy.nextRound(event.symbol, eventVerdict.eventCycleId));
        const signal = this.majorEventSignal(event, eventVerdict, candles, now);
        logDecision(
          `MAJOR P1 事件入场 strategy=${strategy.id} event=${event.id} mode=${eventVerdict.modeTag} ` +
          `round=${pendingRoundOf(rKey)} side=${eventVerdict.side} mark=${mark} ` +
          `riskMultiplier=${eventVerdict.riskMultiplier ?? 1} reason=${eventVerdict.reason}`,
        );

        const result = await this.executeOpen({
          signal,
          rKey,
          side: eventVerdict.side,
          verdict: eventVerdict,
          cfg,
          eq,
          via: 'direct',
        });
        if (result.outcome === 'opened') openSymbols.add(event.symbol);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[trend-auto] MAJOR P1 事件循环失败：', this.lastError);
      void this.selfHealIfReadonly(error);
    } finally {
      this.eventTicking = false;
    }
  }

  /** Standard signal envelope keeps the shared paper executor's audit schema compatible. */
  private majorEventSignal(
    event: EnhancedEventDTO,
    verdict: StrategyMajorEventEntryVerdict,
    candles: Candle1m[],
    now: number,
  ): UnifiedTrendSignal {
    const direction = verdict.side === 'LONG' ? 'up' : 'down';
    const p1At = event.p1At ?? event.firstAt;
    const signal = {
      symbol: event.symbol,
      market: 'futures',
      interval: '1m',
      phase: verdict.side === 'LONG' ? 'CONFIRMED_UP' : 'CONFIRMED_DOWN',
      direction,
      trendCycleId: verdict.eventCycleId,
      trendStartedAt: p1At,
      endPendingSince: null,
      endEvidenceBars: 0,
      endedAt: null,
      endReason: null,
      score: 0,
      strength: 0,
      confirmCount: 0,
      features: {
        atr: 0,
        atrPct: 0,
        realizedVolPct: 0,
        volPercentile: -1,
        volRegime: 'EVENT_DRIVEN',
        efficiencyRatio: 0,
        upperWickPct: 0,
        lowerWickPct: 0,
        breakout: event.breakout.status === 'CONFIRMED' ? direction : 'none',
        falseBreakout: event.breakout.status === 'FALSE',
        barsUsed: candles.length,
      },
      htf5m: { dir: 'flat', valid: false, efficiencyRatio: 0, returnPct: 0, bars: 0 },
      htf15m: { dir: 'flat', valid: false, efficiencyRatio: 0, returnPct: 0, bars: 0 },
      htfAgree: null,
      lastBarTime: candles.length ? candles[candles.length - 1]!.t : now,
      lastKlineAt: now,
      dataFresh: true,
      dataUnavailableReason: null,
      anomaly: {
        dir: event.dir,
        level: event.level,
        priority: event.priority,
        active: event.state === 'ACTIVE',
        lastAt: p1At,
      },
      conflict: false,
      reason: verdict.reason,
      changedAt: now,
      eventTrade: {
        kind: 'major-p1-breakout-v1',
        eventId: event.id,
        p1At,
        modeTag: verdict.modeTag,
        riskMultiplier: verdict.riskMultiplier ?? 1,
        eventDir: event.dir,
        breakoutStatus: event.breakout.status,
        breakoutBaseline: event.breakout.baseline,
        event: {
          level: event.level,
          priority: event.priority,
          peakPriority: event.peakPriority,
          direction: event.direction,
          chg1m: event.chg1m,
          chg5m: event.chg5m,
          volumeMultiple: event.volumeMultiple,
          quoteVolume1m: event.quoteVolume1m,
          evidence: event.evidence,
        },
        ...verdict.metadata,
      },
    };
    return signal as unknown as UnifiedTrendSignal;
  }

  // ============ 持仓结果采集（Task 56 §七） ============

  /**
   * MFE/MAE 增量更新：只用当前 tick 可得的标记价（多源供价的当前快照），逐 tick 维护
   * 「持仓期间」的最大有利/不利浮动盈亏（占初始保证金 %）——绝不使用事后才知道的
   * 最高/最低价构造当时不存在的数据。MFE 更新时刻与峰值后回撤一并落库。
   */
  private async updateOpenStats(): Promise<void> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    for (const meta of openMetas) {
      try {
        const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
        if (!pos || pos.status !== 'OPEN' || !(pos.margin > 0)) continue;
        const mark = this.deps.markPrice(meta.symbol);
        if (!(mark > 0)) continue; // 标记价不可用：跳过本 tick（不用过期价格虚构统计）
        const sign = meta.side === 'LONG' ? 1 : -1;
        const pnlPct = (((mark - pos.entryPrice) * pos.qty * sign) / pos.margin) * 100;
        const prevMfe = meta.mfe ?? null;
        const mfe = prevMfe != null ? Math.max(prevMfe, pnlPct) : pnlPct;
        const mae = meta.mae != null ? Math.min(meta.mae, pnlPct) : pnlPct;
        const isNewPeak = prevMfe == null || pnlPct > prevMfe;
        const mfeAt = isNewPeak ? Date.now() : (meta.mfeAt ?? null);
        const mfeDrawdown = mfe - pnlPct;
        if (
          prevMfe == null ||
          meta.mae == null ||
          Math.abs(mfe - prevMfe) > 1e-9 ||
          Math.abs(mae - meta.mae) > 1e-9
        ) {
          await this.repo.updateTradeStats(meta.positionId, { mfe, mae, mfeAt, mfeDrawdown });
        }
      } catch {
        // 单笔统计失败不影响主循环
      }
    }
  }

  // ============ 退出管理 ============

  /**
   * 退出管理 v4（Task 57：基础设施硬规则优先，策略离场在其内表达）：
   * ① ENDED（lifecycle 已按「连续 N 根不同已收盘 K 线持续证据」确认）→ 平仓，但必须：
   *    a) 信号携带的 trendCycleId 与持仓绑定周期一致（旧周期 ENDED 不杀新周期持仓，
   *       也不仅凭 symbol 平仓）；
   *    b) 信号最近 K 线晚于开仓依据的 K 线（开仓所在 K 线不得作为该持仓的结束证据）。
   * ② END_PENDING（同周期出现结束迹象）→ 只记录首次报警时刻（firstEndSignAt）；
   *    是否提前离场交给策略（短周期套利：走弱先走，走强后按轮次再入场）。
   * ③ 策略离场（evaluateExit）：SPIKE_TAKE 冲高套利 / WEAKNESS_EARLY 走弱提前离场——
   *    基于当时可用的标记价短窗与信号相位，不使用未来数据。
   * ④ 反向趋势已确认（CONFIRMED_*，方向与持仓相反，dataFresh）→ 立即平仓。
   * 数据缺失（DATA_UNAVAILABLE）永不触发离场；信号缺失（退池）不误平仓，仅强平/人工管理。
   */
  private async manageExits(bySymbol: Map<string, UnifiedTrendSignal>): Promise<void> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    const eventDriven = this.strategy.eventDriven === true;
    for (const meta of openMetas) {
      const signal = bySymbol.get(meta.symbol) ?? null;
      if (!signal && !eventDriven) continue;

      if (!eventDriven && signal) {
        if (signal.phase === 'ENDED') {
          if (!signal.trendCycleId || signal.trendCycleId !== meta.trendCycleId) {
            logDecision(
              `离场跳过 ENDED 周期不匹配 symbol=${meta.symbol} posCycle=${meta.trendCycleId} ` +
              `signalCycle=${signal.trendCycleId ?? '-'} positionId=${meta.positionId}`,
            );
            continue;
          }
          const entryBar = this.entryBarTimeOf(meta);
          if (entryBar != null && signal.lastBarTime != null && signal.lastBarTime <= entryBar) {
            logDecision(
              `离场跳过 证据K线未晚于开仓K线 symbol=${meta.symbol} posCycle=${meta.trendCycleId} ` +
              `entryBar=${entryBar} signalBar=${signal.lastBarTime} positionId=${meta.positionId}`,
            );
            continue;
          }
          await this.closePosition(meta, 'TREND_ENDED', signal);
          continue;
        }

        if (signal.phase === 'END_PENDING' && signal.trendCycleId === meta.trendCycleId) {
          if (signal.endPendingSince != null && meta.firstEndSignAt == null) {
            await this.repo.markFirstEndSign(meta.positionId, signal.endPendingSince);
            logDecision(
              `结束迹象首次报警（是否提前离场由策略「${this.strategy.name}」决定） ` +
              `symbol=${meta.symbol} posCycle=${meta.trendCycleId} ev=${signal.endEvidenceBars} positionId=${meta.positionId}`,
            );
          }
        }
      }

      const mark = this.deps.markPrice(meta.symbol);
      if (mark > 0) {
        const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
        if (pos && pos.status === 'OPEN') {
          const verdict = this.strategy.evaluateExit({
            meta,
            pos: {
              entryPrice: pos.entryPrice,
              qty: pos.qty,
              margin: pos.margin,
              side: meta.side as 'LONG' | 'SHORT',
              openedAt: pos.openedAt instanceof Date ? pos.openedAt.getTime() : Number(pos.openedAt),
            },
            mark,
            signal: eventDriven ? null : signal,
            now: Date.now(),
          });
          if (verdict.exit && verdict.reason) {
            logDecision(`策略离场 [${this.strategy.id}] ${verdict.detail} positionId=${meta.positionId}`);
            await this.closePosition(meta, verdict.reason, eventDriven ? null : signal);
            continue;
          }
        }
      }

      if (
        !eventDriven &&
        signal &&
        (signal.phase === 'CONFIRMED_UP' || signal.phase === 'CONFIRMED_DOWN') &&
        (meta.side === 'LONG' ? signal.direction !== 'up' : signal.direction !== 'down') &&
        signal.dataFresh
      ) {
        await this.closePosition(meta, 'REVERSE_CONFIRMED', signal);
      }
    }
  }

  /** 开仓依据的已收盘 K 线（§2.3 守卫用；旧数据缺列时回退到 signalAtOpen.lastBarTime） */
  private entryBarTimeOf(meta: TrendTradeMetaRow): number | null {
    if (meta.entryBarTime != null) return meta.entryBarTime;
    try {
      const s = JSON.parse(meta.signalAtOpen) as { lastBarTime?: number | null };
      return typeof s.lastBarTime === 'number' ? s.lastBarTime : null;
    } catch {
      return null;
    }
  }

  /** 平仓（幂等护栏 = 仓位状态本身；决策行事后审计记录） */
  private async closePosition(
    metaIn: TrendTradeMetaRow,
    reason: TrendExitReason,
    signal: UnifiedTrendSignal | null,
  ): Promise<void> {
    try {
      // 重读最新 meta（同轮 tick 内 ② 可能已写入 firstEndSignAt——避免旧快照覆盖回 null）
      const meta = (await this.repo.getMeta(metaIn.positionId)) ?? metaIn;
      const pos = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (!pos || pos.status !== 'OPEN') {
        // 已终态（并发/重启窗口）：补写 meta 终态
        await this.repo.upsertMeta({
          ...meta,
          status: 'CLOSED',
          exitReason: pos?.status === 'LIQUIDATED' ? 'LIQUIDATED' : reason,
          netPnlWithSlip: (pos?.pnl ?? 0) - meta.slippageEst,
          closedAt: pos?.closedAt ?? new Date(),
        });
        return;
      }
      const r = await this.engine.close(meta.positionId);
      const mark = r.price;
      const closeSlip = mark * pos.qty * (TREND_TRADE.SLIPPAGE_BPS / 10_000);
      const netWithSlip = r.pnl - meta.slippageEst - closeSlip;
      await this.repo.upsertMeta({
        ...meta,
        status: 'CLOSED',
        exitReason: reason,
        exitSignalJson: signal ? JSON.stringify(signal) : null,
        netPnlWithSlip: netWithSlip,
        closedAt: new Date(),
        exitEndReason: signal?.endReason ?? meta.exitEndReason ?? null,
        exitEvidenceBars: signal?.endEvidenceBars ?? meta.exitEvidenceBars ?? null,
        closeNotional: mark * pos.qty,
      });
      const round = meta.entryRound ?? 1;
      await this.repo.claimDecision({
        id: `${roundKey(meta.trendCycleId, round)}:CLOSE`,
        symbol: meta.symbol,
        action: reason === 'REVERSE_CONFIRMED' ? 'REVERSE_CLOSE' : 'CLOSE',
        cycleId: meta.trendCycleId,
        positionId: meta.positionId,
        detail: JSON.stringify({
          reason,
          round,
          strategyId: this.strategy.id,
          exitEndReason: signal?.endReason ?? null,
          exitEvidenceBars: signal?.endEvidenceBars ?? null,
          exitPrice: r.price,
          netPnl: r.pnl,
          netPnlWithSlip: netWithSlip,
          mfe: meta.mfe ?? null,
          mae: meta.mae ?? null,
          endReason: signal?.endReason ?? null,
        }),
      });
      // 策略回调：保留轮次状态供「走强再入场」判定
      this.strategy.onClose(meta.symbol, meta.trendCycleId, reason, Date.now(), mark);
      this.closes++;
      logDecision(
        `平仓 reason=${reason} strategy=${this.strategy.id} round=${round} endReason=${signal?.endReason ?? '-'} symbol=${meta.symbol} ` +
          `side=${meta.side} posCycle=${meta.trendCycleId} positionId=${meta.positionId} ` +
          `ev=${signal?.endEvidenceBars ?? '-'} exitPrice=${mark} netPnl=${r.pnl.toFixed(4)} ` +
          `netWithSlip=${netWithSlip.toFixed(4)} mfe=${meta.mfe?.toFixed(1) ?? '-'}% mae=${meta.mae?.toFixed(1) ?? '-'}%`,
      );
    } catch (e) {
      // 平仓暂时性失败（行情不可用等）：下一轮重试（决策行未写，不烧掉本周期）
      // ⚠️ 此处只能用入参 metaIn——重读的 meta 声明在 try 作用域内，catch 引用会 ReferenceError
      if (!(e instanceof PaperError)) {
        this.pushSkip(metaIn.symbol, `平仓异常：${e instanceof Error ? e.message : e}`, metaIn.trendCycleId);
      }
    }
  }

  /** 强平巡检后的 meta 终态补写（强平是执行结果，如实记录、不伪装模型止损） */
  private async finalizeNewLiquidations(): Promise<void> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    for (const m of openMetas) {
      const pos = await db.paperPosition.findUnique({ where: { id: m.positionId } });
      if (pos && pos.status === 'LIQUIDATED') {
        await this.finalizeLiquidated(m, pos.margin, pos.pnl ?? -pos.margin);
      }
    }
  }

  private async finalizeLiquidated(m: TrendTradeMetaRow, margin: number, pnl: number): Promise<void> {
    await this.repo.upsertMeta({
      ...m,
      status: 'CLOSED',
      exitReason: 'LIQUIDATED',
      netPnlWithSlip: pnl - m.slippageEst,
      closedAt: new Date(),
    });
    const round = m.entryRound ?? 1;
    await this.repo.claimDecision({
      id: `${roundKey(m.trendCycleId, round)}:CLOSE`,
      symbol: m.symbol,
      action: 'CLOSE',
      cycleId: m.trendCycleId,
      positionId: m.positionId,
      detail: JSON.stringify({ reason: 'LIQUIDATED', round, netPnlWithSlip: pnl - m.slippageEst, margin }),
    });
    this.strategy.onClose(m.symbol, m.trendCycleId, 'LIQUIDATED', Date.now());
    this.closes++;
    logDecision(
      `强平 symbol=${m.symbol} side=${m.side} posCycle=${m.trendCycleId} round=${round} positionId=${m.positionId} ` +
        `margin=${margin.toFixed(2)} pnl=${pnl.toFixed(4)}`,
    );
  }

  // ============ 开仓决策（Task 57：方向/门槛/模式判定全部交给策略） ============

  /** 策略入场评估上下文（快照；策略不得改动） */
  private strategyCtx(
    now: number,
    mark: number,
    cfg: TrendAutoConfigRow,
    eq: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number },
    openSymbols: Set<string>,
    lastCloseAt: number | null,
  ): StrategyMarketCtx {
    return { now, mark, cfg, equity: eq, openSymbols, lastCloseAt };
  }

  /** 开仓时高周期门控状态标签（快照存档用；方向分级与策略同源） */
  private htfGateLabel(signal: UnifiedTrendSignal): HtfGateState {
    const trendDir = signal.direction === 'down' ? 'down' : 'up';
    const g5 = classifyHtf(signal.htf5m.dir, signal.htf5m.valid, trendDir);
    const g15 = classifyHtf(signal.htf15m.dir, signal.htf15m.valid, trendDir);
    if (g5 === 'INVALID' || g15 === 'INVALID') return 'INVALID';
    if (g5 === 'OPPOSED') return 'OPPOSED';
    if (g5 === 'NEUTRAL') return g15 === 'OPPOSED' ? 'OPPOSED' : 'NEUTRAL';
    return g15; // 5m ALIGNED：标签反映 15m 状态（ALIGNED/NEUTRAL/OPPOSED）
  }

  // ============ 待入场转换 / 新信号扫描（Task 57：门槛判定全部由当前策略执行） ============

  /**
   * 待入场管理（二次确认）：每个 ACTIVE 待入场记录在出现「更新的已收盘 K 线」后
   * 全量复核（策略门槛/相位/周期/数据/冷却/容量/资金），通过才开仓；趋势失效、数据过期、
   * 门槛不再满足或记录过期 → 取消并记录原因。每轮次至多一条记录、只允许成功开仓一次
   * （决策键 `{cycleId}#R{round}:OPEN` 数据库唯一约束兜底）。
   */
  private async managePendings(
    bySymbol: Map<string, UnifiedTrendSignal>,
    cfg: TrendAutoConfigRow,
    eq: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number },
  ): Promise<void> {
    const pendings = await this.repo.loadActivePendings();
    for (const p of pendings) {
      const signal = bySymbol.get(p.symbol);
      const cancel = async (reason: string): Promise<void> => {
        await this.repo.markPendingCanceled(p.cycleId, reason);
        logDecision(
          `待入场取消 roundKey=${p.cycleId} symbol=${p.symbol} reason=${reason} ` +
            `ageMs=${Date.now() - p.firstSeenAt}`,
        );
      };
      // ① 记录过期（等待超时——趋势确认后长期未出现合格的新 K 线）
      if (Date.now() - p.firstSeenAt > TREND_TRADE.PENDING_EXPIRE_MS) {
        await cancel('待入场超时（等待新收盘 K 线复核超限）');
        continue;
      }
      // ② 信号缺失/数据过期/相位失效/周期变化 → 取消（§5.3：趋势失效或数据过期取消记录）
      if (!signal) {
        await cancel('信号缺失（标的退池/未评估）');
        continue;
      }
      if (!signal.dataFresh) {
        await cancel(`数据过期（${signal.dataUnavailableReason ?? '未知'}）`);
        continue;
      }
      if (
        !(TREND_TRADE.CONFIRMED_PHASES as readonly string[]).includes(signal.phase) ||
        signal.trendCycleId !== baseCycleOf(p.cycleId)
      ) {
        await cancel(`趋势失效（phase=${signal.phase}，cycle=${signal.trendCycleId ?? '-'}）`);
        continue;
      }
      // ③ 还没等到「新的已收盘 K 线」→ 继续等待（二次确认核心等待条件）
      if (signal.lastBarTime == null || signal.lastBarTime <= p.firstBarTime) continue;
      // ④ 冷却复核：冷却以 symbol 为单位，不因周期/轮次变化绕过（时长控制台可调）
      const lastClose = await this.repo.lastCloseAt(p.symbol);
      if (lastClose != null && Date.now() - lastClose < cooldownOf(cfg)) {
        await cancel('转换时进入同币种冷却期');
        continue;
      }
      // ⑤ 策略门槛全量复核（方向/模式/评分/ER/轮次——与创建时同一策略判定）
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
      }
      // ⑥-⑩ 开仓（共享 executeOpen：容量/同币防御/资金测算/幂等抢占/开仓/审计全同构——
      // 待入场转换与「二次确认关闭→直接开仓」两条路径走同一实现，行为不分叉）
      const outcome = await this.executeOpen({
        signal,
        rKey: p.cycleId,
        side: p.side as 'LONG' | 'SHORT',
        verdict,
        cfg,
        eq,
        via: 'pending',
        waitedSince: p.firstSeenAt,
        onConverted: (positionId) => this.repo.markPendingConverted(p.cycleId, positionId),
      });
      if (outcome.outcome === 'opened') continue;
      if (outcome.outcome === 'capacity') continue; // 保留记录，等下轮复核直到过期（审计已在 executeOpen 记录）
      if (outcome.outcome === 'transient') {
        // 行情暂时不可用：释放待入场记录，下轮同周期可重建重试（决策已被 executeOpen 释放）
        await this.repo.deletePending(p.cycleId);
        continue;
      }
      // skipped：资金/上限/防御类永久跳过——取消待入场并记录原因（审计行已在 executeOpen 落库）
      await cancel(outcome.reason ?? '开仓跳过');
    }
  }

  /**
   * 尝试把「策略想开仓」落成真实持仓（Task 57-c 抽取：待入场转换 / 直接开仓共用）。
   * 守卫顺序与 Task 56 验收语义一致：容量 → 同币防御 → 资金测算 → 幂等抢占 → 开仓 →
   * meta/审计/回调。返回结果由调用方决定待入场记录的保留/取消/释放。
   */
  private async executeOpen(input: {
    signal: UnifiedTrendSignal;
    /** `{cycleId}#R{round}`（幂等键与轮次的唯一定位） */
    rKey: string;
    side: 'LONG' | 'SHORT';
    verdict: StrategyEntryVerdict;
    cfg: TrendAutoConfigRow;
    eq: { balance: number; marginUsed: number; unrealized: number; equity: number; openCount: number };
    /** 审计来源：pending = 待入场转换（二次确认通过）/ direct = 直接开仓（二次确认关闭） */
    via: 'pending' | 'direct';
    /** 等待起点（pending = firstSeenAt；direct 无）——审计 waitedMs 用 */
    waitedSince?: number;
    /** pending 专属：开仓成功后把待入场记录标记 CONVERTED */
    onConverted?: (positionId: string) => Promise<void>;
  }): Promise<
    | { outcome: 'opened' }
    | { outcome: 'capacity' }
    | { outcome: 'skipped'; reason: string }
    | { outcome: 'transient'; reason: string }
  > {
    const { signal, rKey, side, verdict, cfg, eq, via } = input;
    const posCycle = baseCycleOf(rKey);
    const skipLabel = via === 'pending' ? '待入场转换' : '直接开仓';

    // ⑥ 容量守卫：pending 保留记录继续等；direct 仅记录跳过
    if (eq.openCount >= cfg.maxPositions) {
      this.pushSkip(
        signal.symbol,
        `${skipLabel}等待容量（已达最大持仓数 ${cfg.maxPositions}）`,
        rKey,
      );
      return { outcome: 'capacity' };
    }
    // ⑦ 同 symbol 已有持仓（防御；正常由周期决策键保证）
    const dup = await db.paperPosition.findFirst({
      where: { accountId: await this.autoAccountId(), symbol: signal.symbol, status: 'OPEN' },
    });
    if (dup) {
      return { outcome: 'skipped', reason: '同币种已有持仓' };
    }
    // ⑧ 仓位测算（Task 67 舱位划分：每仓保证金 = 权益 × min(设定上限, 95%÷配置舱位数)——
    //    选 1 舱单仓满配 95%，选 N 舱各 95%/N，每舱配额固定、先开仓不挤占后开舱；
    //    Task 65 动态版按 (当前持仓数+1) 均分，首仓永远吃满 95%、后舱只剩残羹（用户复盘废弃）。
    //    超出可用余额直接跳过）。费率唯一真值 = 引擎实例 feeRate（Task 59：自动账户 0.02%；
    //    测试注入引擎默认 TAKER_FEE，口径随引擎走）
    const feeRate = this.engine.feeRate;
    const feeFactor = 1 + cfg.leverage * feeRate;
    const effRatio = effectiveMarginRatio(cfg.marginRatio, cfg.maxPositions);
    const riskMultiplier = typeof verdict.riskMultiplier === 'number' && Number.isFinite(verdict.riskMultiplier)
      ? Math.max(0.1, Math.min(1, verdict.riskMultiplier))
      : 1;
    const effRatioPct = (effRatio * riskMultiplier * 100).toFixed(2).replace(/\.?0+$/, '');
    const targetMargin = floor2(eq.equity * effRatio * riskMultiplier);
    const fee = targetMargin * cfg.leverage * feeRate;
    if (targetMargin + fee > eq.balance) {
      const reason = `权益 ${effRatioPct}% 保证金 ${targetMargin.toFixed(2)} + 手续费 ${fee.toFixed(2)} 超出可用余额 ${eq.balance.toFixed(2)}（跳过不变通）`;
      await this.recordSkipDb(signal.symbol, rKey, reason);
      return { outcome: 'skipped', reason };
    }
    if (targetMargin < TREND_TRADE.MIN_MARGIN) {
      const reason = `权益 ${effRatioPct}% 保证金 ${targetMargin} 低于最小保证金 ${TREND_TRADE.MIN_MARGIN}`;
      await this.recordSkipDb(signal.symbol, rKey, reason);
      return { outcome: 'skipped', reason };
    }
    // ⑨ 幂等守卫（数据库唯一约束兜底）：抢占 `{cycleId}#R{round}:OPEN` 决策
    const claimed = await this.repo.claimDecision({
      id: `${rKey}:OPEN`,
      symbol: signal.symbol,
      action: 'OPEN',
      cycleId: posCycle,
      detail: JSON.stringify(this.openDetail(signal, targetMargin, cfg, verdict.modeTag, riskMultiplier, side)),
    });
    if (!claimed) {
      return { outcome: 'skipped', reason: '本趋势周期本轮次已决策过（幂等）' };
    }
    try {
      // Task 75 反向跟随（infra reverseMode，控制台可调、全算法生效）：仅翻转真实执行方向，
      // 模型决策世界不变——meta.side 保持模型侧（evaluateExit/REVERSE_CONFIRMED/再入场/轮次
      // 等策略逻辑全部按模型语义运转），真实持仓为 execSide；平仓按 positionId 执行、时机跟随
      // 模型 → 模型硬止损=我们止盈离场、模型止盈/趋势结束=我们止损离场，盈亏互为镜像；
      // 强平按真实仓位由 paper 引擎如实模拟（权益/未实现盈亏本就按真实持仓 side 计算）。
      const reverse = (cfg.reverseMode ?? 0) === 1;
      const execSide: 'LONG' | 'SHORT' = reverse ? (side === 'LONG' ? 'SHORT' : 'LONG') : side;
      if (reverse) {
        logDecision(
          `反向跟随执行 模型${side === 'LONG' ? '开多' : '开空'} → 实际${execSide === 'LONG' ? '开多' : '开空'} ` +
          `symbol=${signal.symbol} rKey=${rKey} margin=${targetMargin}`,
        );
      }
      const pos = await this.engine.open({
        symbol: signal.symbol,
        side: execSide,
        leverage: cfg.leverage,
        margin: targetMargin,
      });
      const slippageEst = targetMargin * cfg.leverage * (cfg.slippageBps / 10_000);
      await this.repo.upsertMeta({
        positionId: pos.id,
        trendCycleId: posCycle,
        symbol: signal.symbol,
        side,
        trendPhaseAtOpen: signal.phase,
        scoreAtOpen: signal.score,
        featuresAtOpen: JSON.stringify({
          strategyId: this.strategy.id,
          modeTag: verdict.modeTag,
          vol: signal.features,
          htf5m: signal.htf5m,
          htf15m: signal.htf15m,
          htfAgree: signal.htfAgree,
          strength: signal.strength,
          anomaly: signal.anomaly,
          conflict: signal.conflict,
        }),
        signalAtOpen: JSON.stringify(signal),
        slippageEst,
        status: 'OPEN',
        exitReason: null,
        exitSignalJson: null,
        netPnlWithSlip: null,
        openDecisionAt: new Date(),
        closedAt: null,
        // 开仓快照（可查询列）
        entryEr: signal.features.efficiencyRatio,
        htf5mDir: signal.htf5m.dir,
        htf15mDir: signal.htf15m.dir,
        htfGate: this.htfGateLabel(signal),
        entryNotional: targetMargin * cfg.leverage,
        entryBarTime: signal.lastBarTime,
        mfe: null,
        mae: null,
        mfeAt: null,
        mfeDrawdown: null,
        firstEndSignAt: null,
        exitEndReason: null,
        exitEvidenceBars: null,
        closeNotional: null,
        entryRound: pendingRoundOf(rKey),
      });
      if (input.onConverted) await input.onConverted(pos.id);
      await this.attachPosition(`${rKey}:OPEN`, pos.id);
      // 策略回调：轮次 +1 / 新周期初始化（持久化到 TrendStrategyState）
      this.strategy.onOpen(signal.symbol, posCycle, signal.lastBarTime, Date.now());
      this.opens++;
      eq.openCount += 1;
      eq.marginUsed += targetMargin;
      eq.balance -= targetMargin + fee;
      eq.equity -= fee; // equity = balance + marginUsed + unrealized 自洽（开仓瞬时浮亏≈0）
      const waitedMs =
        input.waitedSince != null ? ` waitedMs=${Date.now() - input.waitedSince}` : '';
      logDecision(
        `开仓（${via === 'pending' ? '二次确认通过' : '直接开仓·二次确认关闭'}）strategy=${this.strategy.id} mode=${verdict.modeTag} ` +
          `round=${pendingRoundOf(rKey)} symbol=${signal.symbol} side=${side} posCycle=${posCycle} ` +
          `positionId=${pos.id} margin=${targetMargin}(${effRatioPct}%权益=min(${Math.round(cfg.marginRatio * 100)}%,95%/${cfg.maxPositions}仓)) ` +
          `leverage=${cfg.leverage}x entryBar=${signal.lastBarTime}${waitedMs} ` +
          `score=${signal.score.toFixed(0)} er=${signal.features.efficiencyRatio.toFixed(2)} ` +
          `htf5m=${signal.htf5m.dir} htf15m=${signal.htf15m.dir}`,
      );
      return { outcome: 'opened' };
    } catch (e) {
      if (isTransientOpenError(e)) {
        // 行情暂时不可用：释放决策（下轮同周期可重建/重试）
        await this.releaseDecision(`${rKey}:OPEN`);
        this.pushSkip(signal.symbol, `开仓暂时失败（将重试）：${e instanceof Error ? e.message : e}`, rKey);
        return { outcome: 'transient', reason: e instanceof Error ? e.message : String(e) };
      }
      // 永久跳过（保证金/上限类）：决策保留防重入
      const msg = e instanceof Error ? e.message : String(e);
      this.pushSkip(signal.symbol, `开仓跳过：${msg}`, rKey);
      return { outcome: 'skipped', reason: `开仓跳过：${msg}` };
    }
  }

  /**
   * 新信号扫描（Task 57）：对每个「数据新鲜 + 确认相位」的趋势信号询问当前策略是否想开仓
   * （方向/模式/评分/ER/轮次上限全部由策略判定）。
   * Task 57-c 二次确认开关（waitBarConfirm，控制台可调）：
   * - 开（默认）：创建待入场记录（主键 `{cycleId}#R{round}`，等下一根已收盘 K 线复核），不立即下单；
   * - 关：同 tick 直接开仓（executeOpen 全量守卫：容量/同币/资金/幂等）——快 1 根 K 线，少一层防护。
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

      // 同币种冷却：平仓后冷却期内新信号只记录不执行（时长控制台可调）；到期后重走完整门槛
      const lastClose = await this.repo.lastCloseAt(signal.symbol);
      if (lastClose != null && Date.now() - lastClose < cooldownOf(cfg)) {
        this.recordSkip(
          signal.symbol,
          `同币种冷却中（距上次平仓 ${Math.ceil((Date.now() - lastClose) / 1000)}s / ${cooldownOf(cfg) / 1000}s）`,
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

      // Task 57-c 二次确认开关：开（默认）→ 建待入场等下一根收盘 K 线复核；
      // 关 → 同 tick 直接开仓（executeOpen 内容量/同币/资金/幂等全量守卫，快 1 根 K 线）
      if ((cfg.waitBarConfirm ?? 1) === 1) {
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
      } else {
        const r = await this.executeOpen({ signal, rKey, side, verdict, cfg, eq, via: 'direct' });
        if (r.outcome === 'opened') pendingSymbols.add(signal.symbol); // 同轮循环内容量即时收紧
        // capacity/skipped/transient 审计已在 executeOpen 内落（不烧轮次：无 pending 无决策残留）
      }
    }
  }

  private openDetail(signal: UnifiedTrendSignal, margin: number, cfg: TrendAutoConfigRow, modeTag: string, riskMultiplier = 1, side: 'LONG' | 'SHORT' = 'LONG') {
    return {
      strategyId: this.strategy.id,
      modeTag,
      phase: signal.phase,
      direction: signal.direction,
      score: signal.score,
      strength: signal.strength,
      confirmCount: signal.confirmCount,
      trendStartedAt: signal.trendStartedAt,
      lastBarTime: signal.lastBarTime,
      margin,
      riskMultiplier,
      leverage: cfg.leverage,
      /** Task 58 建；Task 67 语义定版：sizing = 开仓时权益 × min(设定上限, 95%÷配置舱位数)（保证金 + 手续费超出余额则跳过） */
      marginBasis: `equity × min(${cfg.marginRatio}, ${TREND_TRADE.MARGIN_SLOT_HEADROOM}/${cfg.maxPositions}) × ${riskMultiplier} (skip if unaffordable)`,
      entryEr: signal.features.efficiencyRatio,
      htf5mDir: signal.htf5m.dir,
      htf15mDir: signal.htf15m.dir,
      htfGate: this.htfGateLabel(signal),
      volRegime: signal.features.volRegime,
      atrPct: signal.features.atrPct,
      efficiencyRatio: signal.features.efficiencyRatio,
      htfAgree: signal.htfAgree,
      // Task 75：反向跟随快照（开启时记录模型侧与实际执行侧；平仓仍跟随模型）
      ...((cfg.reverseMode ?? 0) === 1
        ? { reverseMode: true, modelSide: side, execSide: side === 'LONG' ? 'SHORT' : 'LONG' }
        : { reverseMode: false }),
    };
  }

  // ============ 账户/统计 ============

  private autoAccountIdCache: string | null = null;
  private async autoAccountId(): Promise<string> {
    if (this.autoAccountIdCache) return this.autoAccountIdCache;
    const acc = await db.paperAccount.findUnique({ where: { name: TREND_TRADE.ACCOUNT_NAME } });
    if (!acc) throw new Error('趋势自动账户未初始化');
    this.autoAccountIdCache = acc.id;
    return acc.id;
  }

  private async accountEquity(accId: string): Promise<{
    balance: number;
    marginUsed: number;
    unrealized: number;
    equity: number;
    openCount: number;
  }> {
    const acc = await db.paperAccount.findUnique({ where: { id: accId } });
    const open = await db.paperPosition.findMany({ where: { accountId: accId, status: 'OPEN' } });
    let marginUsed = 0;
    let unrealized = 0;
    for (const p of open) {
      const mark = this.deps.markPrice(p.symbol);
      const m = mark > 0 ? mark : p.entryPrice;
      marginUsed += p.margin;
      unrealized += (m - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1);
    }
    const balance = acc?.balance ?? 0;
    return {
      balance,
      marginUsed,
      unrealized,
      equity: balance + marginUsed + unrealized,
      openCount: open.length,
    };
  }

  private pushSkip(symbol: string, reason: string, cycleId?: string): void {
    this.skips.unshift({ t: Date.now(), symbol, reason, cycleId });
    if (this.skips.length > 200) this.skips.length = 200;
  }

  /**
   * Task 72：事件路径拒绝记录（带节流去重）。事件循环每 1s 对每个活跃 MAJOR P1 事件重复
   * 评估：同一事件同一原因 60s 只记一条、原因变化立即记录；memo 超 64 条时清理 10 分钟前
   * 的旧键防泄漏。cycleId 留空（事件周期键在策略内部，面板展示以原因为主）。
   */
  private recordEventSkip(event: { id: string; symbol: string }, reason: string): void {
    const now = Date.now();
    if (this.eventSkips.size > 64) {
      for (const [key, memo] of this.eventSkips) {
        if (now - memo.at > 600_000) this.eventSkips.delete(key);
      }
    }
    const prev = this.eventSkips.get(event.id);
    if (prev && prev.reason === reason && now - prev.at < 60_000) return;
    this.eventSkips.set(event.id, { reason, at: now });
    this.pushSkip(event.symbol, reason);
  }

  /** 内存审计（容量/独立性/冷却/门槛等轻量跳过） */
  private recordSkip(symbol: string, reason: string, cycleId: string): void {
    this.pushSkip(symbol, reason, cycleId);
  }

  /** DB 审计（余额/权益类硬性跳过：`{cycleId}:SKIP` 决策行，不阻断后续重试） */
  private async recordSkipDb(symbol: string, cycleId: string, reason: string): Promise<void> {
    this.pushSkip(symbol, reason, cycleId);
    try {
      await this.repo.claimDecision({
        id: `${cycleId}:SKIP`,
        symbol,
        action: 'SKIP',
        cycleId,
        detail: JSON.stringify({ reason, t: Date.now() }),
      });
    } catch {
      // 审计失败不影响决策
    }
  }

  private async releaseDecision(id: string): Promise<void> {
    try {
      await db.$executeRawUnsafe(`DELETE FROM TrendAutoDecision WHERE id = ? AND positionId IS NULL`, id);
    } catch {
      // 释放失败保守处理：该周期不再开仓（幂等优先于重试）
    }
  }

  private async attachPosition(decisionId: string, positionId: string): Promise<void> {
    try {
      await db.$executeRawUnsafe(
        `UPDATE TrendAutoDecision SET positionId = ? WHERE id = ?`,
        positionId,
        decisionId,
      );
    } catch {
      // 绑定失败不影响交易（meta 已建立关联）
    }
  }

  // ============ 控制操作（任务 §5.3：开启/暂停/恢复/全部平仓语义分离） ============

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

  async pause(): Promise<void> {
    await this.repo.updateMode(TREND_TRADE.ACCOUNT_NAME, 'PAUSED');
  }

  async resume(): Promise<void> {
    await this.repo.updateMode(TREND_TRADE.ACCOUNT_NAME, 'RUNNING');
  }

  async closeOne(positionId: string): Promise<{ ok: boolean; message: string }> {
    const meta = await this.repo.getMeta(positionId);
    if (!meta || meta.status !== 'OPEN') return { ok: false, message: '持仓不存在或已平仓' };
    const signal = this.deps.getSignals().find((s) => s.symbol === meta.symbol) ?? null;
    await this.closePosition(meta, 'MANUAL', signal);
    return { ok: true, message: '已提交平仓' };
  }

  async closeAllManual(): Promise<{ closed: number; skipped: number; totalPnlWithSlip: number }> {
    const openMetas = await this.repo.loadMetasByStatus('OPEN');
    const signals = this.deps.getSignals();
    let closed = 0;
    let skipped = 0;
    let total = 0;
    for (const meta of openMetas) {
      const signal = signals.find((s) => s.symbol === meta.symbol) ?? null;
      const before = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (!before || before.status !== 'OPEN') {
        skipped++;
        continue;
      }
      await this.closePosition(meta, 'MANUAL', signal);
      const after = await db.paperPosition.findUnique({ where: { id: meta.positionId } });
      if (after && after.status !== 'OPEN') {
        closed++;
        total += after.pnl ?? 0;
      } else {
        skipped++;
      }
    }
    return { closed, skipped, totalPnlWithSlip: total };
  }

  /**
   * 重置机器人账户（重置后资金回到 100 USDT）：
   * ① 先按标记价正常平掉全部 OPEN 持仓（走引擎平仓：释放保证金、记录流水与 MANUAL 审计）；
   * ② 清空该账户全部持仓与成交流水（PaperPosition/PaperTrade）；
   * ③ 清空趋势关联与决策审计（TrendTradeMeta/TrendAutoDecision/TrendPendingEntry——
   *    仅趋势自动账户使用，不带账户维度，全表清空安全）；
   * ④ 余额 = initialCapital（100）、totalDeposited = 0（ROI 本金基准 = initialCapital +
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
  }

  mode(): Promise<TrendAutoMode | null> {
    return this.repo.loadConfig(TREND_TRADE.ACCOUNT_NAME).then((c) => (c?.mode as TrendAutoMode) ?? null);
  }

  // ============ 对外查询（/api/trend-trading 用） ============

  /** 标记价（合约多源供价；外部路由展示持仓用） */
  markPriceOf(symbol: string): number {
    return this.deps.markPrice(symbol);
  }

  /** 最近一次主循环时间（ms；0 = 尚未运行） */
  get lastTick(): number {
    return this.lastTickAt;
  }

  /** 最近一次主循环错误（null = 正常） */
  /**
   * Task 78：readonly 自愈——平台快照替换 db 文件（内容/锁状态）会让运行中 Prisma 连接
   * 永久 1032 readonly（Task 54/70/78 三次现场；文件本身可直写）。实测 $disconnect() 后
   * 惰性重连可恢复写能力（重连重新 open 当前文件并校验锁，scripts/task78_reconnect_probe*.ts）。
   * 命中 readonly 错误即断开连接，下个 tick 惰性重连自愈；非 readonly 错误零开销返回。
   */
  private async selfHealIfReadonly(e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/readonly|1032/i.test(msg)) return;
    if (this.readonlyHealing) return; // 同一轮 healing 进行中，避免并发重复断开
    this.readonlyHealing = true;
    try {
      await db.$disconnect();
      logDecision('检测到数据库连接 readonly（平台快照替换文件），已断开等待惰性重连自愈（下个 tick 生效）');
    } catch {
      /* disconnect 失败忽略——下个 tick 重试 */
    } finally {
      // 给惰性重连留出窗口后复位；期间新错误也不会重复断开（连接已在重连路径上）
      setTimeout(() => (this.readonlyHealing = false), 5_000).unref?.();
    }
  }

  get lastErr(): string | null {
    return this.lastError;
  }

  /** Task 82：配置算法装配失配标记（null = 无失配；测试与诊断用） */
  get strategyDesyncId(): string | null {
    return this.strategyDesync;
  }

  /** 最近跳过记录（审计：为什么没开仓/为什么跳过） */
  recentSkips(limit = 50): SkipRecord[] {
    return this.skips.slice(0, limit);
  }
}
