// apply-order-refunds-mirror — create the public.order_refunds mirror table
// (docs/brain/specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile.md, Phase 1).
// The mirror closes the Sonia Stevens SC132396 double-refund failure mode — a
// vendor refund that succeeded but couldn't be confirmed on retry. Idempotent
// (CREATE … IF NOT EXISTS + unique index).
//   npx tsx scripts/apply-order-refunds-mirror.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260918120000_order_refunds_mirror.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: tbls } = await c.query(
      "select table_name from information_schema.tables where table_name = 'order_refunds'",
    );
    console.log("✓ table present:", tbls.map((r) => r.table_name));
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename = 'order_refunds' order by indexname",
    );
    console.log("✓ indexes present:", idx.map((r) => r.indexname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
