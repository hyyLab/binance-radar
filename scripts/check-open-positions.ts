import { Database } from "bun:sqlite";
const db = new Database("db/custom.db", { readonly: true });
const cols = db.query("PRAGMA table_info(PaperPosition)").all().map(c=>c.name);
console.log("PaperPosition columns:", cols.join(", "));
const rows = db.query("SELECT * FROM PaperPosition WHERE status='OPEN' ORDER BY openedAt").all();
console.log("OPEN positions:", rows.length);
for (const r of rows) console.log(JSON.stringify(r));
const cfg = db.query("SELECT * FROM TrendAutoConfig").all();
console.log("config:", JSON.stringify(cfg));

