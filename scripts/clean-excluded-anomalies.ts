// 一次性清理：删除 DB 中代币化股票 / 商品代币的历史异动事件（与全站展示规则一致）
// 运行：bun scripts/clean-excluded-anomalies.ts
import { PrismaClient } from '@prisma/client';

const STOCK_TICKERS = new Set([
  'MSTR', 'CRCL', 'HOOD', 'TSLA', 'AAPL', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'MSFT',
  'META', 'COIN', 'PLTR', 'ORCL', 'NFLX', 'AVGO', 'LLY', 'JPM', 'ABNB', 'SBET',
  'DFDV', 'CEP', 'SMLR', 'BTBT', 'SPY', 'QQQ', 'SOXL', 'SPCX', 'SNDK',
]);
const EXTRA_EXCLUDED_BASES = new Set([
  'XAUT', 'XAUTB', 'PAXG', 'PAXGB', 'KAU', 'KAUB', 'RLUSD',
]);

function isExcludedBase(base: string): boolean {
  if (EXTRA_EXCLUDED_BASES.has(base)) return true;
  if (STOCK_TICKERS.has(base)) return true;
  if (base.endsWith('B') && STOCK_TICKERS.has(base.slice(0, -1))) return true;
  return false;
}

const db = new PrismaClient();

const rows = await db.anomalyEvent.findMany({ select: { id: true, baseAsset: true } });
const excluded = rows.filter((r) => isExcludedBase(r.baseAsset));
const byBase = new Map<string, number>();
for (const r of excluded) byBase.set(r.baseAsset, (byBase.get(r.baseAsset) ?? 0) + 1);

if (excluded.length > 0) {
  const res = await db.anomalyEvent.deleteMany({
    where: { id: { in: excluded.map((r) => r.id) } },
  });
  console.log(`deleted ${res.count} rows:`, [...byBase.entries()].map(([b, c]) => `${b}×${c}`).join(', '));
} else {
  console.log('no excluded anomaly rows found');
}

await db.$disconnect();
