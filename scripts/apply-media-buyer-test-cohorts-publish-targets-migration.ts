// apply-media-buyer-test-cohorts-publish-targets-migration —
// media-buyer-test-winner-loop Phase 2. Adds default_meta_account_id +
// default_meta_page_id + default_meta_instagram_user_id to
// public.media_buyer_test_cohorts (all nullable, additive). Idempotent
// (add column if not exists). Run against the pooler:
//   npx tsx scripts/apply-media-buyer-test-cohorts-publish-targets-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260707130000_media_buyer_test_cohorts_publish_targets.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_test_cohorts' and column_name like 'default_meta_%' order by column_name",
    );
    console.log(`✓ default publish-target columns: ${rows.map((r) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
