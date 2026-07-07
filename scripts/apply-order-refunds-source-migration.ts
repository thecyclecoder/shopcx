// apply-order-refunds-source-migration — add the `source` marker to
// public.order_refunds so backfill rows are distinguishable from
// live-fire mirror rows.
// (docs/brain/specs/backfill-order-refunds-ledger-from-history.md, Phase 1).
// Idempotent (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).
//   npx tsx scripts/apply-order-refunds-source-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260922120000_order_refunds_source.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name, data_type, column_default
         from information_schema.columns
        where table_name = 'order_refunds' and column_name = 'source'`,
    );
    console.log("✓ source column:", cols);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename = 'order_refunds' and indexname = 'order_refunds_source_idx'",
    );
    console.log("✓ source index present:", idx.map((r) => r.indexname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
