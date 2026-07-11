import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs";
(async () => {
  const sql = readFileSync("supabase/migrations/20261012120000_logistics_suppliers_po_annotations.sql","utf8");
  const c = pgClient(); await c.connect();
  try { await c.query(sql); console.log("APPLIED suppliers + po_annotations migration"); }
  finally { await c.end(); }
})();
