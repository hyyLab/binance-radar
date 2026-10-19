import { Database } from "bun:sqlite";
const db = new Database("db/custom.db", { readonly: true });
const cols = db.query("PRAGMA table_info(TrendTradeMeta)").all().map(c=>c.name);
console.log("TrendTradeMeta columns:", cols.join(", "));
const rows = db.query("SELECT * FROM TrendTradeMeta ORDER BY rowid DESC LIMIT 8").all();
for (const r of rows) { const f=r.featuresAtOpen?JSON.parse(r.featuresAtOpen):null; console.log("META:", r.symbol, "| strategyId:", f?.strategyId, "| score:", f?.score, "| positionId:", r.positionId); }

