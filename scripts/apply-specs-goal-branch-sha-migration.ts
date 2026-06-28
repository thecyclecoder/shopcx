// apply-specs-goal-branch-sha-migration — add public.specs.goal_branch_sha
// (spec-goal-branch-pm-flow M4 — the "on the goal branch" marker column). Idempotent (ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-specs-goal-branch-sha-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260728120000_specs_goal_branch_sha.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='specs' and column_name='goal_branch_sha'",
    );
    console.log(`✓ specs.goal_branch_sha column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
