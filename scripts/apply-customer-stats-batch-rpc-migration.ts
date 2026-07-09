import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const c = pgClient();
  await c.connect();
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20260708130000_customer_stats_batch_rpc.sql"),
    "utf8",
  );
  await c.query(sql);
  console.log("✓ applied 20260708130000_customer_stats_batch_rpc.sql");
  await c.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
