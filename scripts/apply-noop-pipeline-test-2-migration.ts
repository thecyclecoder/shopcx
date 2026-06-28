/**
 * Apply 20260731120000_noop_pipeline_test_2.sql — NO-OP pipeline validation v2 Phase 2.
 * Idempotent (ADD COLUMN IF NOT EXISTS). Run: npx tsx scripts/apply-noop-pipeline-test-2-migration.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

(async () => {
  const sql = readFileSync(
    resolve(__dirname, "../supabase/migrations/20260731120000_noop_pipeline_test_2.sql"),
    "utf8",
  );
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    const { rows } = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public' and table_name='director_activity' and column_name='_noop_pipeline_test_2'`,
    );
    console.log("director_activity._noop_pipeline_test_2 applied:", rows);
  } finally {
    await c.end();
  }
  process.exit(0);
})();
