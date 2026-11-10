// ---------- PA 整合 · API 公共辅助（ensureSchema + 单例启动 + 统一错误格式） ----------

import { ensurePaSchema } from '@/lib/pa-integration/repo';
import { paScheduler } from '@/lib/pa-integration/scheduler';

/** 每个 PA API 入口调用：建表幂等 + 调度器拉起（扫描/执行/队列三循环） */
export async function paApiBoot(): Promise<void> {
  await ensurePaSchema();
  await paScheduler().ensureStarted();
}

export function paApiError(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}
