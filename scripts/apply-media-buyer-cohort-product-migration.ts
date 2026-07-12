// apply-media-buyer-cohort-product-migration —
// media-buyer-product-scoped-test-rail Phase 1. Adds product_id to
// public.media_buyer_test_cohorts + replaces the (workspace, account) active-
// cohort uniqueness with (workspace, account, product). Additive + idempotent
// (add column if not exists, drop index if exists, create unique index if not
// exists). Run against the pooler:
//   npx tsx scripts/apply-media-buyer-cohort-product-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261015120000_media_buyer_cohort_product.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_test_cohorts' and column_name='product_id'",
    );
    console.log(`✓ media_buyer_test_cohorts.product_id present: ${cols.length === 1}`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='media_buyer_test_cohorts' and indexname='media_buyer_test_cohorts_ws_account_product_active_key'",
    );
    console.log(`✓ product-scoped active-cohort unique index present: ${idx.length === 1}`);
    const { rows: gone } = await c.query(
      "select indexname from pg_indexes where tablename='media_buyer_test_cohorts' and indexname='media_buyer_test_cohorts_ws_account_active_key'",
    );
    console.log(`✓ old (workspace, account) unique index removed: ${gone.length === 0}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
