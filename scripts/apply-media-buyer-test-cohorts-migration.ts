// apply-media-buyer-test-cohorts-migration — create public.media_buyer_test_cohorts
// + add ad_publish_jobs.origin (media-buyer-test-winner-loop Phase 1). Idempotent
// (create table if not exists, alter add column if not exists, policy guards).
// Run against the pooler:
//   npx tsx scripts/apply-media-buyer-test-cohorts-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260707120000_media_buyer_test_cohorts.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='media_buyer_test_cohorts'",
    );
    console.log(`✓ media_buyer_test_cohorts table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_test_cohorts' order by ordinal_position",
    );
    console.log(`✓ media_buyer_test_cohorts columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: origin } = await c.query(
      "select column_name from information_schema.columns where table_name='ad_publish_jobs' and column_name='origin'",
    );
    console.log(`✓ ad_publish_jobs.origin present: ${origin.length === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
