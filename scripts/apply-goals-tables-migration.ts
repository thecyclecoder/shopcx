// apply-goals-tables-migration — create public.goals + public.goal_milestones, promote
// public.specs.milestone_id to a typed FK, and install the rollup + parent_goal_id cycle-guard triggers
// (db-driven-specs M5, goals-milestones-tables-and-backfill Phase 1).
// Idempotent (CREATE TABLE / INDEX IF NOT EXISTS; CREATE OR REPLACE FUNCTION; DROP/CREATE TRIGGER;
// ALTER TABLE ... ADD CONSTRAINT guarded by an information_schema check).
// Run against the pooler:
//   npx tsx scripts/apply-goals-tables-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260725130000_goals_and_goal_milestones.sql"];

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
      `select constraint_name from information_schema.table_constraints
        where table_schema='public' and table_name='specs'
          and constraint_name='specs_milestone_id_fkey'`,
    );
    console.log(`✓ specs.milestone_id FK present: ${fk.length === 1}`);

    const { rows: fns } = await c.query(
      `select proname from pg_proc where proname in (
        'roll_up_milestone_status',
        'specs_milestone_rollup_trigger',
        'roll_up_goal_status',
        'goal_milestones_rollup_trigger',
        'goals_parent_cycle_guard'
      ) order by proname`,
    );
    console.log(`✓ functions present: ${fns.map((r) => r.proname).join(", ")}`);

    const { rows: trigs } = await c.query(
      `select tgname from pg_trigger
        where tgname in ('specs_milestone_rollup','goal_milestones_rollup','goals_parent_cycle')
          and not tgisinternal
        order by tgname`,
    );
    console.log(`✓ triggers present: ${trigs.map((r) => r.tgname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
