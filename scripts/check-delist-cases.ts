/** Task 85 查证:cashcat/icnt 退池平仓后的价格走势(用户反馈「平仓后都有不小的涨幅」) */
import { Database } from 'bun:sqlite';

const db = new Database('db/custom.db', { readonly: true });

const rows = db
  .query(
    `SELECT p.id, p.symbol, p.side, p.status, p.entryPrice, p.exitPrice, p.qty, p.margin, p.pnl,
            p.openedAt, p.closedAt, m.exitReason
     FROM PaperPosition p LEFT JOIN TrendTradeMeta m ON m.positionId = p.id
     WHERE p.symbol LIKE '%CASHCAT%' OR p.symbol LIKE '%ICNT%'
     ORDER BY p.openedAt DESC LIMIT 10`,
  )
  .all() as Array<Record<string, unknown>>;

console.log('rows =', rows.length);
for (const r of rows) {
  console.log(
    JSON.stringify({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      status: r.status,
      entry: r.entryPrice,
      close: r.exitPrice,
      pnl: r.pnl,
      margin: r.margin,
      openedAt: r.openedAt ? new Date(Number(r.openedAt)).toISOString() : null,
      closedAt: r.closedAt ? new Date(Number(r.closedAt)).toISOString() : null,
      exitReason: r.exitReason ?? null,
    }),
  );
}

// 当前仍 OPEN 的退池类持仓(信号缺失状态)
const open = db
  .query(
    `SELECT p.id, p.symbol, p.side, p.entryPrice, p.margin, p.openedAt
     FROM PaperPosition p JOIN TrendTradeMeta m ON m.positionId = p.id
     WHERE p.status = 'OPEN' ORDER BY p.openedAt ASC`,
  )
  .all() as Array<Record<string, unknown>>;
console.log('\nOPEN positions =', open.length);
for (const r of open) {
  console.log(
    JSON.stringify({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      entry: r.entryPrice,
      margin: r.margin,
      openedAt: new Date(Number(r.openedAt)).toISOString(),
    }),
  );
}

db.close();
