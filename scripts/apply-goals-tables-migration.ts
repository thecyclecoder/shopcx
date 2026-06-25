// apply-goals-tables-migration — create public.goals + public.goal_milestones
// (db-driven-specs M5 Phase 1: the two new top-tier relations + rollup triggers + RLS).
//
// Idempotent: every CREATE uses IF NOT EXISTS. Re-running is a no-op once applied.
//
// Run against the pooler:
//   npx tsx scripts/apply-goals-tables-migration.ts
//
// Verify with `scripts/_verify-goals-schema.ts` per the verify-schema recipe.
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260725120000_goals_and_goal_milestones.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const tables = await c.query(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_name in ('goals','goal_milestones')
        order by table_name`,
    );
    console.log(`✓ tables present: ${tables.rows.map((r) => r.table_name).join(", ") || "(none)"}`);
    const fns = await c.query(
      `select proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('roll_up_goal_status','roll_up_milestone_status','goals_check_acyclic_parent')
        order by proname`,
    );
    console.log(`✓ functions present: ${fns.rows.map((r) => r.proname).join(", ") || "(none)"}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
