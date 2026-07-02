// apply-competitors-whitelisted-migration — Phase 1 of whitelisted-page-auto-tracking.
// Adds competitors.search_keyword (text), competitors.runs_ads_for (uuid → competitors.id),
// and extends the source CHECK to include 'whitelisted'. Idempotent. Run via:
//   npx tsx scripts/apply-competitors-whitelisted-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260808120000_competitors_whitelisted.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8");
    await c.query(sql);
    console.log(`✓ applied ${MIGRATION}`);

    // Confirm the shape landed.
    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='competitors'
          and column_name in ('search_keyword','runs_ads_for')
        order by column_name`,
    );
    console.log("✓ new columns:", cols);

    const { rows: check } = await c.query(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname='competitors_source_check'`,
    );
    console.log("✓ source CHECK:", check[0]?.def);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
