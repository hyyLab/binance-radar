// ---------- PA 整合 · 调度器（单例装配 + 三循环） ----------
// 三个互相独立的定时循环（任务书 §7.2：交易循环绝不等待 AI）：
//   ① 扫描循环（60s）：全池读取 → 合并去重 → 快速筛选 → 投递分析任务
//   ② AI 队列泵（10s）：按并发上限拉起异步分析（Stage1→协同→Stage2→Validator→建单）
//   ③ 执行循环（5s）：强平巡检 / 待入场单触发 / 止损 / TP1 / TP2 / 趋势失效退出
// 单例经 globalThis 驻留（HMR 安全）；改行为必 bump key（radar 纪律）。

import { loadPaConfig } from './config';
import { ensurePaSchema } from './repo';
import { PaActionTrader } from './pa-trader';
import { PaAnalysisQueue } from './analysis-queue';
import { scanOnce, lastScanStats } from './candidate-scanner';

const SCAN_INTERVAL_MS = 60_000;
const QUEUE_PUMP_MS = 10_000;
const EXECUTE_INTERVAL_MS = 5_000;

export class PaScheduler {
  readonly trader = new PaActionTrader();
  readonly queue: PaAnalysisQueue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private executing = false;
  private scanning = false;
  startedAt = 0;
  lastScanAt = 0;
  lastExecuteAt = 0;
  lastError: string | null = null;

  constructor() {
    this.queue = new PaAnalysisQueue(this.trader, loadPaConfig);
  }

  async ensureStarted(): Promise<void> {
    if (this.startedAt > 0) return;
    this.startedAt = Date.now();
    await ensurePaSchema();
    await this.trader.ensureAccount();
    if (!this.timer) {
      this.timer = setInterval(() => void this.tickAll(), 5_000);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.startedAt = 0;
  }

  /** 5s 心跳：分发三个循环（各自带重入保护与独立节奏） */
  private async tickAll(): Promise<void> {
    const now = Date.now();
    const cfg = await loadPaConfig().catch(() => null);
    if (!cfg) return;

    // 执行循环（5s）——任何模式下都跑（暂停只停新开仓，风险管理与退出照常）
    if (!this.executing && now - this.lastExecuteAt >= EXECUTE_INTERVAL_MS) {
      this.executing = true;
      this.lastExecuteAt = now;
      void this.trader
        .executionTick(cfg)
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => {
          this.executing = false;
        });
    }

    // AI 队列泵（10s）
    if (!this.pumping && now - (this.lastScanAt - 60_000) >= QUEUE_PUMP_MS) {
      this.pumping = true;
      void this.queue
        .pump()
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => {
          this.pumping = false;
        });
    }

    // 扫描循环（60s）
    if (!this.scanning && now - this.lastScanAt >= SCAN_INTERVAL_MS) {
      this.scanning = true;
      this.lastScanAt = now;
      void scanOnce(cfg, this.queue, this.trader)
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => {
          this.scanning = false;
        });
    }
  }

  stats() {
    return {
      startedAt: this.startedAt,
      lastScanAt: this.lastScanAt,
      lastExecuteAt: this.lastExecuteAt,
      lastError: this.lastError,
      scan: lastScanStats(),
      queue: this.queue.stats(),
    };
  }

  /** 手动触发一次扫描 + 队列泵（API analyze 入口/页面刷新用） */
  async kickScan(): Promise<void> {
    const cfg = await loadPaConfig();
    await scanOnce(cfg, this.queue, this.trader);
    await this.queue.pump();
  }
}

// 单例（v1 首版；改行为必 bump key）
const gSched = globalThis as typeof globalThis & {
  __paActionScheduler_v1?: PaScheduler;
};

export function paScheduler(): PaScheduler {
  return (gSched.__paActionScheduler_v1 ??= new PaScheduler());
}
