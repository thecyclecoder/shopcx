// apply-orders-easypost-tracking-migration — add jsonb column
// public.orders.easypost_tracking (portal-order-detail-tracking-widget, Phase 1).
// Idempotent (ADD COLUMN IF NOT EXISTS). Run via:
//   npx tsx scripts/apply-orders-easypost-tracking-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260916120000_orders_easypost_tracking.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name, data_type
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'orders'
         and column_name = 'easypost_tracking'`,
    );
    if (rows.length === 0) {
      throw new Error("orders.easypost_tracking not found after apply");
    }
    if (rows[0].data_type !== "jsonb") {
      throw new Error(
        `orders.easypost_tracking has data_type=${rows[0].data_type}, expected jsonb`,
      );
    }
    console.log("✓ verified: orders.easypost_tracking jsonb");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
