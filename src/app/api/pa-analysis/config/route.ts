// GET  /api/pa-analysis/config —— 读取运行时配置（含代码默认值说明）
// PUT  /api/pa-analysis/config —— 保存配置（后端 validatePaConfigPatch 严格校验；热生效）

import { paApiBoot } from '@/lib/pa-integration/api-helpers';
import { loadPaConfig, savePaConfig, validatePaConfigPatch, PA_ACTION_DEFAULTS } from '@/lib/pa-integration/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await paApiBoot();
    const cfg = await loadPaConfig();
    return Response.json({ ok: true, config: cfg, defaults: PA_ACTION_DEFAULTS });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    await paApiBoot();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return Response.json({ ok: false, error: '请求体非法' }, { status: 400 });
    const { error, clean } = validatePaConfigPatch(body);
    if (error) return Response.json({ ok: false, error }, { status: 400 });
    const cfg = await savePaConfig(clean);
    return Response.json({ ok: true, config: cfg, message: '配置已保存并热生效（下一轮循环生效）' });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
