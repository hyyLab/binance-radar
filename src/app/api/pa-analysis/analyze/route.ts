// POST /api/pa-analysis/analyze —— 手动触发分析
// body: { symbol?: string }（缺省 = 立即全池扫描 + 投递全部合格候选）
// 幂等/冷却/并发全部复用调度器逻辑；AI 未完成时返回排队状态（前端轮询候选列表）。

import { paApiBoot, paApiError } from '@/lib/pa-integration/api-helpers';
import { paScheduler } from '@/lib/pa-integration/scheduler';
import { loadPaConfig } from '@/lib/pa-integration/config';
import { db } from '@/lib/db';
import { getEnhancedEngine } from '@/lib/market/enhanced/engine';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await paApiBoot();
    const body = (await req.json().catch(() => ({}))) as { symbol?: string };
    const sched = paScheduler();

    if (body.symbol) {
      const symbol = String(body.symbol).toUpperCase().trim();
      const sig = getEnhancedEngine()
        .trendWatch.latestSignals()
        .find((s) => s.symbol === symbol);
      if (!sig || !(sig.phase === 'CONFIRMED_UP' || sig.phase === 'CONFIRMED_DOWN')) {
        return paApiError(`UTE 相位不支持分析（${sig?.phase ?? '无信号'}）——PA 只分析确认趋势内的择时`);
      }
      const direction: 'LONG' | 'SHORT' = sig.direction === 'up' ? 'LONG' : 'SHORT';
      const cfg = await loadPaConfig();
      if (cfg.aiEnabled !== 1) return paApiError('AI 分析开关已关闭（config.aiEnabled）');
      const enqueued = sched.queue.enqueue(symbol, direction, sig.trendCycleId);
      await db.paCandidate.upsert({
        where: { symbol },
        create: { symbol, status: 'PA_ANALYZING', sourcePoolsJson: '[]', lastReason: '手动触发分析' },
        update: { status: 'PA_ANALYZING', lastReason: '手动触发分析' },
      });
      void sched.queue.pump().catch(() => {});
      return Response.json({
        ok: true,
        enqueued,
        symbol,
        direction,
        message: enqueued ? '已加入分析队列（约 20-60s 出结果）' : '该 symbol 已在队列中',
      });
    }

    // 全池扫描 + 队列泵
    await sched.kickScan();
    return Response.json({ ok: true, message: '已触发全池扫描', scheduler: sched.stats() });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
