import { Database } from 'bun:sqlite';

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true });

console.log('=== AGTUSDT 最近持仓记录 ===');
const rows = db
  .query(
    `SELECT id, symbol, side, status, entryPrice, exitPrice, margin, openedAt, closedAt
     FROM PaperPosition WHERE symbol='AGTUSDT' ORDER BY openedAt DESC LIMIT 2`,
  )
  .all() as any[];
for (const r of rows) {
  console.log(JSON.stringify(r));
  if (r.id) {
    const meta = db
      .query(
        `SELECT status, exitReason, netPnlWithSlip, mfe, mae, closedAt
         FROM TrendTradeMeta WHERE positionId = ? LIMIT 1`,
      )
      .get(r.id as string) as any;
    if (meta) console.log('  meta:', JSON.stringify(meta));
  }
}

console.log('=== 全局最近平仓 6 笔 ===');
const recent = db
  .query(
    `SELECT symbol, side, status, exitReason, ROUND(netPnlWithSlip,2) AS pnl, closedAt
     FROM TrendTradeMeta ORDER BY closedAt DESC LIMIT 6`,
  )
  .all() as any[];
for (const r of recent) console.log(JSON.stringify(r));

export {};
