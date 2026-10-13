import { NextResponse } from 'next/server';
import { collector } from '@/lib/market/collector';
import { scanner } from '@/lib/market/scanner';

export const dynamic = 'force-dynamic';

/**
 * 采集器运维开关（封禁止血用，无需重启服务）：
 * GET /api/market/collector/pause            → 查看当前状态
 * GET /api/market/collector/pause?pause=1    → 全静默（清定时器 + monkey-patch ensureStarted，防 UI 轮询拉起）
 * GET /api/market/collector/pause?probe=1    → 单次 ping 现货桶（权重≈1），读 Retry-After 判断解封时间
 * GET /api/market/collector/pause?resume=1   → 解除 patch、归零 started/starting 并立即拉起
 *
 * 运维节奏：封禁时 pause → 等待 Retry-After 到期 + ≥2 分钟缓冲 → probe 确认 200 → resume。
 * 注意：429 期间探测可能被升级为 418（IP 拉黑），距到期太近探测会顺延封禁窗口。
 */

const g = globalThis as typeof globalThis & {
  __radarOpsPaused?: boolean;
};

function patchInstance(target: object, timers: string[]): void {
  const inst = target as Record<string, unknown>;
  for (const key of timers) {
    const t = inst[key];
    if (t != null) {
      try {
        clearInterval(t as ReturnType<typeof setInterval>);
      } catch {
        // 忽略无效句柄
      }
    }
    inst[key] = null;
  }
  // 实例级 monkey-patch：UI 轮询路由调用 ensureStarted 时直接跳过
  (inst as { ensureStarted: () => Promise<void> }).ensureStarted = async () => {};
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const collectorRec = collector as unknown as Record<string, unknown>;
  const scannerRec = scanner as unknown as Record<string, unknown>;
  const status = () => ({
    opsPaused: !!g.__radarOpsPaused,
    collectorStarted: collectorRec.started === true,
    scannerStarted: scannerRec.started === true,
  });

  try {
    if (url.searchParams.get('pause') === '1') {
      patchInstance(collector, ['priceTimer', 'tfTimer']);
      patchInstance(scanner, ['signalTimer', 'levelTimer']);
      g.__radarOpsPaused = true;
      return NextResponse.json({ ok: true, action: 'PAUSED', ...status() });
    }

    if (url.searchParams.get('resume') === '1') {
      // 归零启动标志后重拉，否则旧实例 started=true 会跳过重建定时器
      for (const inst of [collectorRec, scannerRec]) {
        delete (inst as { ensureStarted?: unknown }).ensureStarted;
        inst.started = false;
        inst.starting = null;
      }
      g.__radarOpsPaused = false;
      await collector.ensureStarted();
      return NextResponse.json({ ok: true, action: 'RESUMED', ...status() });
    }

    if (url.searchParams.get('probe') === '1') {
      // 单次 ping（权重≈1）：429/418 时读 Retry-After；全程不触发采集器
      const t0 = Date.now();
      try {
        const res = await fetch('https://api.binance.com/api/v3/time', { cache: 'no-store' });
        const retryAfter = res.headers.get('retry-after');
        return NextResponse.json({
          ok: true,
          probe: {
            status: res.status,
            latencyMs: Date.now() - t0,
            retryAfterSec: retryAfter ? Number(retryAfter) : null,
          },
          ...status(),
        });
      } catch (e) {
        return NextResponse.json({
          ok: true,
          probe: {
            status: 'ERROR',
            latencyMs: Date.now() - t0,
            note: e instanceof Error ? e.message : 'probe failed',
          },
          ...status(),
        });
      }
    }

    return NextResponse.json({ ok: true, ...status() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'ops error', ...status() },
      { status: 500 },
    );
  }
}
