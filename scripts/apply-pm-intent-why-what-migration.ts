// apply-pm-intent-why-what-migration — add why/what columns to the PM tree
// (pm-structured-intent-and-refs Phase 1). Adds:
//   public.goals.why (goals.outcome already carries the WHAT — reconcile, don't duplicate)
//   public.goal_milestones.why + goal_milestones.what
//   public.specs.why + specs.what
//   public.spec_phases.why + spec_phases.what
// Idempotent (ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-pm-intent-why-what-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260807140000_pm_intent_why_what.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const table of ["goals", "goal_milestones", "specs", "spec_phases"]) {
      const { rows: cols } = await c.query(
        "select column_name from information_schema.columns where table_name=$1 and column_name in ('why','what') order by column_name",
        [table],
      );
      console.log(`✓ ${table} intent columns: ${cols.map((r) => r.column_name).join(", ") || "(none)"}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
