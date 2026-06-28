/**
 * Apply 20260729120000_goals_is_parent.sql — spec-goal-branch-pm-flow M5 parent-goal exemption flag.
 * Idempotent (ADD COLUMN IF NOT EXISTS). Run: npx tsx scripts/apply-goals-is-parent-migration.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

(async () => {
  const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260729120000_goals_is_parent.sql"), "utf8");
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    const { rows } = await c.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='goals' and column_name='is_parent'`,
    );
    console.log("goals.is_parent applied:", rows);
  } finally {
    await c.end();
  }
  process.exit(0);
})();
