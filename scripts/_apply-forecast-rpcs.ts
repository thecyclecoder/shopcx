import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs";
(async () => {
  const sql = readFileSync("supabase/migrations/20261012140000_logistics_forecast_rpcs.sql","utf8");
  const c = pgClient(); await c.connect();
  try { await c.query(sql); console.log("APPLIED forecast RPCs"); } finally { await c.end(); }
})();
