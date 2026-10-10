import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { collector } from '@/lib/market/collector';
import type { StatsResponse } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await collector.ensureStarted();
    const stats = collector.getStats();

    let anomaliesLast1h = 0;
    let anomaliesLast24h = 0;
    try {
      const now = Date.now();
      [anomaliesLast1h, anomaliesLast24h] = await Promise.all([
        db.anomalyEvent.count({ where: { createdAt: { gte: new Date(now - 3600_000) } } }),
        db.anomalyEvent.count({ where: { createdAt: { gte: new Date(now - 86400_000) } } }),
      ]);
    } catch {
      // DB 不可用时降级为内存统计
      const now = Date.now();
      const mem = collector.getMemoryAnomalies();
      anomaliesLast1h = mem.filter((a) => now - new Date(a.createdAt).getTime() < 3600_000).length;
      anomaliesLast24h = mem.filter((a) => now - new Date(a.createdAt).getTime() < 86400_000).length;
    }

    const res: StatsResponse = { ok: true, ...stats, anomaliesLast1h, anomaliesLast24h };
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
