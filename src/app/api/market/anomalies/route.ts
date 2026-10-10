import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { collector } from '@/lib/market/collector';
import type { AnomalyEventDTO, AnomaliesResponse, AnomalyType, AnomalySeverity } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

function dedupeKey(a: { symbol: string; type: string; createdAt: string }): string {
  return `${a.symbol}|${a.type}|${Math.floor(new Date(a.createdAt).getTime() / 60_000)}`;
}

export async function GET() {
  await collector.ensureStarted();
  const since = new Date(Date.now() - 48 * 3600_000);
  let dbEvents: AnomalyEventDTO[] = [];
  try {
    const rows = await db.anomalyEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    dbEvents = rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      base: r.base,
      type: r.type as AnomalyType,
      severity: r.severity as AnomalySeverity,
      price: r.price,
      changePct: r.changePct,
      volumeMultiple: r.volumeMultiple,
      quoteVolume1m: r.quoteVolume1m,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    dbEvents = [];
  }

  // 合并内存中尚未落库（或落库失败）的事件
  const seen = new Set<string>();
  const merged: AnomalyEventDTO[] = [];
  const all = [...collector.getMemoryAnomalies(), ...dbEvents];
  for (const ev of all) {
    const k = dedupeKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(ev);
  }
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const data = merged.slice(0, 300);

  const res: AnomaliesResponse = { ok: true, ts: Date.now(), count: data.length, data };
  return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
}
