// apply-noop-pipeline-test-column-migration — noop-pipeline-test-1 Phase 2. Adds the harmless additive,
// nullable scratch column `_noop_pipeline_test text` to public.director_activity. The column is read/written
// by NOTHING; it exists only to exercise the migration-approval gate in the build pipeline. Idempotent
// (IF NOT EXISTS).
//   npx tsx scripts/apply-noop-pipeline-test-column-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260731120000_noop_pipeline_test_column.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='director_activity' and column_name='_noop_pipeline_test'`,
    );
    if (!rows.length) throw new Error("column _noop_pipeline_test missing after apply");
    console.log(`✓ present: ${JSON.stringify(rows[0])}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
