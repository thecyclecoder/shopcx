// apply-specs-tables-migration — create public.specs + public.spec_phases + the roll_up_spec_status
// function + the row-level trigger (db-driven-specs M1, spec-body-table-and-backfill Phase 1).
// Idempotent (CREATE TABLE / INDEX IF NOT EXISTS; CREATE OR REPLACE FUNCTION; DROP/CREATE TRIGGER).
// Run against the pooler:
//   npx tsx scripts/apply-specs-tables-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260713120000_specs_and_spec_phases.sql"];

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
        where table_schema='public' and table_name in ('specs','spec_phases')
        order by table_name`,
    );
    console.log(`✓ tables present: ${tables.map((r) => r.table_name).join(", ")}`);

    const { rows: fns } = await c.query(
      `select proname from pg_proc where proname in ('roll_up_spec_status','spec_phases_rollup_trigger','specs_deferred_rollup_trigger')`,
    );
    console.log(`✓ functions present: ${fns.map((r) => r.proname).join(", ")}`);

    const { rows: trigs } = await c.query(
      `select tgname from pg_trigger where tgname in ('spec_phases_rollup','specs_deferred_rollup') and not tgisinternal`,
    );
    console.log(`✓ triggers present: ${trigs.map((r) => r.tgname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
