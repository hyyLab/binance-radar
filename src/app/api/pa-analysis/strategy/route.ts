// POST /api/pa-analysis/strategy —— 策略控制（body.action: start | pause | resume）
// start = enabled=1（全池扫描 + AI 分析 + 新开仓开启）；pause = enabled=0（停新开仓，
// 已有持仓的止损/TP/趋势失效管理与强平巡检照常——任务书 §9.4 红线）；resume = start。

import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { paScheduler } from '@/lib/pa-integration/scheduler';
import { loadPaConfig, savePaConfig } from '@/lib/pa-integration/config';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await paApiBoot();
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = String(body.action ?? '').toLowerCase();
    if (action !== 'start' && action !== 'pause' && action !== 'resume') {
      return Response.json({ ok: false, error: 'action 必须为 start | pause | resume' }, { status: 400 });
    }
    const cfg = await loadPaConfig();
    const enabled = action === 'pause' ? 0 : 1;
    const saved = await savePaConfig({ ...cfg, enabled });
    await paScheduler().ensureStarted();
    return Response.json({
      ok: true,
      config: saved,
      message:
        enabled === 1
          ? 'pa-action-v1 已启用（全池扫描/AI 分析/自动模拟开仓开启；持仓管理持续运行）'
          : 'pa-action-v1 已暂停新开仓（已有持仓的止损/止盈/趋势失效退出与强平巡检照常运行）',
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
