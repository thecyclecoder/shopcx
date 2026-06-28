// apply-noop-pipeline-test-4-migration — add public.director_activity._noop_pipeline_test_4
// (noop-pipeline-test-4 spec P2: additive nullable text column, no reader/writer — exercises
// the migration script-approval gate + resume-stamp path of the one-off PM pipeline).
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-noop-pipeline-test-4-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260731120000_noop_pipeline_test_4.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='director_activity' and column_name='_noop_pipeline_test_4'",
    );
    console.log(`✓ director_activity._noop_pipeline_test_4 column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
