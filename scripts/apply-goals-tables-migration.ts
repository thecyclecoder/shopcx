// apply-goals-tables-migration — create public.goals + public.goal_milestones, add the
// specs.milestone_id FK constraint, install the cycle-protection + rollup triggers
// (db-driven-specs M5, goals-milestones-tables-and-backfill Phase 1).
// Idempotent (CREATE TABLE / INDEX IF NOT EXISTS; CREATE OR REPLACE FUNCTION; DROP/CREATE TRIGGER;
// the FK constraint is added inside a DO block guarded by pg_constraint).
// Run against the pooler:
//   npx tsx scripts/apply-goals-tables-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260726120000_goals_and_goal_milestones.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: tables } = await c.query(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name in ('goals','goal_milestones')
        order by table_name`,
    );
    console.log(`✓ tables present: ${tables.map((r) => r.table_name).join(", ")}`);

    const { rows: fk } = await c.query(
      `select conname from pg_constraint where conname='specs_milestone_id_fkey' and conrelid='public.specs'::regclass`,
    );
    console.log(`✓ specs.milestone_id FK present: ${fk.length === 1}`);

    const { rows: fns } = await c.query(
      `select proname from pg_proc where proname in (
         'roll_up_milestone_status',
         'roll_up_goal_status',
         'goals_reject_parent_cycle',
         'specs_milestone_rollup_trigger',
         'goal_milestones_rollup_trigger'
       ) order by proname`,
    );
    console.log(`✓ functions present: ${fns.map((r) => r.proname).join(", ")}`);

    const { rows: trigs } = await c.query(
      `select tgname from pg_trigger where tgname in (
         'goals_parent_cycle_check',
         'specs_milestone_rollup',
         'specs_milestone_rollup_upd',
         'goal_milestones_rollup'
       ) and not tgisinternal order by tgname`,
    );
    console.log(`✓ triggers present: ${trigs.map((r) => r.tgname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
