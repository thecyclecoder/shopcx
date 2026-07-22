// apply-media-buyer-retarget-cohorts-migration — create
// public.media_buyer_retarget_cohorts, the RETARGET-rail sibling of
// media_buyer_test_cohorts + media_buyer_cold_scaler_cohorts (v3 Ad Creative
// Engine goal M3 Phase 1). Idempotent (create table if not exists,
// create unique index if not exists, policy DO blocks). Run against the
// pooler:
//   npx tsx scripts/apply-media-buyer-retarget-cohorts-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261127120000_media_buyer_retarget_cohorts.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='media_buyer_retarget_cohorts'",
    );
    console.log(`✓ media_buyer_retarget_cohorts table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_retarget_cohorts' order by ordinal_position",
    );
    console.log(`✓ media_buyer_retarget_cohorts columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='media_buyer_retarget_cohorts' and indexname='media_buyer_retarget_cohorts_ws_account_product_active_key'",
    );
    console.log(`✓ partial active-key unique index present: ${idx.length === 1}`);
    const { rows: rls } = await c.query(
      "select relrowsecurity from pg_class where relname='media_buyer_retarget_cohorts'",
    );
    console.log(`✓ RLS enabled: ${rls[0]?.relrowsecurity === true}`);
    const { rows: pol } = await c.query(
      "select policyname from pg_policies where tablename='media_buyer_retarget_cohorts' order by policyname",
    );
    console.log(`✓ policies: ${pol.map((r) => r.policyname).join(", ")}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
