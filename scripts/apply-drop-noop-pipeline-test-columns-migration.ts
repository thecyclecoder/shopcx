// apply-drop-noop-pipeline-test-columns-migration — drop the throwaway no-op columns the
// noop-pipeline-test-1..6 PM-flow validation specs added to public.director_activity
// (_noop_pipeline_test / _2 / _3 / _4 / _6). Idempotent (DROP COLUMN IF EXISTS). Run against the pooler:
//   npx tsx scripts/apply-drop-noop-pipeline-test-columns-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260801120000_drop_noop_pipeline_test_columns.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='director_activity'
       and column_name like '\\_noop\\_pipeline\\_test%' order by column_name`,
    );
    console.log(`✓ remaining noop_pipeline_test columns on director_activity: ${rows.length === 0 ? "none" : rows.map((r) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
