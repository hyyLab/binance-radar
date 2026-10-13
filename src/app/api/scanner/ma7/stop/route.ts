import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * 运维开关：停掉当前进程中 MA(7) 扫描器单例的定时扫描（无需重启 dev server）。
 * 背景：M(7) 已从 UI 移除，但长驻进程里的旧单例 interval 仍在按 60s 扫描
 * （每轮最多 600 次 K 线请求），需要在不重启的前提下止损。
 * 新进程无需调用本路由：/api/scanner/ma7 已移除 ensureStarted，扫描器不会自启。
 */
export async function GET() {
  const g = globalThis as {
    __binanceRadarMa7?: { timer?: unknown; scanning?: boolean; started?: boolean };
  };
  const inst = g.__binanceRadarMa7;
  let cleared = false;
  if (inst?.timer) {
    clearInterval(inst.timer as ReturnType<typeof setInterval>);
    inst.timer = null;
    cleared = true;
  }
  return NextResponse.json({
    ok: true,
    ts: Date.now(),
    hadInstance: !!inst,
    clearedTimer: cleared,
    wasScanning: !!inst?.scanning,
    note: cleared ? 'MA7 scan timer cleared' : 'no active timer found',
  });
}
