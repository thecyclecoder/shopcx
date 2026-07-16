// apply-media-buyer-cohort-excluded-purchaser-audience-migration — adds the
// nullable text column public.media_buyer_test_cohorts.excluded_purchaser_audience_id
// (bianca-cold-test-recent-purchaser-exclusion Phase 1). Idempotent
// (add column if not exists). Run against the pooler:
//   npx tsx scripts/apply-media-buyer-cohort-excluded-purchaser-audience-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261025120000_media_buyer_cohort_excluded_purchaser_audience.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: col } = await c.query(
      "select column_name, data_type, is_nullable from information_schema.columns where table_name='media_buyer_test_cohorts' and column_name='excluded_purchaser_audience_id'",
    );
    console.log(
      `✓ excluded_purchaser_audience_id present: ${col.length === 1} (type=${col[0]?.data_type}, nullable=${col[0]?.is_nullable})`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
