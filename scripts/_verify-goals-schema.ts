// _verify-goals-schema — print the live shape of public.goals + public.goal_milestones + the new FK on
// public.specs.milestone_id (goals-milestones-tables-and-backfill Phase 1). Read-only — eyeball the
// printed columns / indexes / triggers / policies against the migration spec.
//   npx tsx scripts/_verify-goals-schema.ts
import { pgClient } from "./_bootstrap";

async function printColumns(c: ReturnType<typeof pgClient>, table: string) {
  const r = await c.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema='public' and table_name=$1
      order by ordinal_position`,
    [table],
  );
  console.log(`\n--- ${table} columns (${r.rows.length}) ---`);
  for (const row of r.rows) {
    console.log(`  ${row.column_name.padEnd(22)} ${String(row.data_type).padEnd(28)} ${row.is_nullable === "NO" ? "NOT NULL" : "NULL    "} ${row.column_default ?? ""}`);
  }
}

async function printIndexes(c: ReturnType<typeof pgClient>, table: string) {
  const r = await c.query(
    `select indexname, indexdef from pg_indexes where schemaname='public' and tablename=$1 order by indexname`,
    [table],
  );
  console.log(`\n--- ${table} indexes (${r.rows.length}) ---`);
  for (const row of r.rows) console.log(`  ${row.indexname} :: ${row.indexdef}`);
}

async function printPolicies(c: ReturnType<typeof pgClient>, table: string) {
  const r = await c.query(
    `select policyname, cmd, roles from pg_policies where schemaname='public' and tablename=$1 order by policyname`,
    [table],
  );
  console.log(`\n--- ${table} RLS policies (${r.rows.length}) ---`);
  for (const row of r.rows) console.log(`  ${row.policyname} (${row.cmd}) → ${row.roles}`);
}

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const t of ["goals", "goal_milestones"]) {
      await printColumns(c, t);
      await printIndexes(c, t);
      await printPolicies(c, t);
    }

    const trigs = await c.query(
      `select tgname, tgrelid::regclass::text as relname
         from pg_trigger
        where tgname in ('specs_milestone_rollup','goal_milestones_rollup','goals_parent_cycle')
          and not tgisinternal
        order by tgname`,
    );
    console.log(`\n--- triggers (${trigs.rows.length}) ---`);
    for (const row of trigs.rows) console.log(`  ${row.tgname} on ${row.relname}`);

    const fns = await c.query(
      `select proname from pg_proc
        where proname in (
          'roll_up_milestone_status',
          'roll_up_goal_status',
          'specs_milestone_rollup_trigger',
          'goal_milestones_rollup_trigger',
          'goals_parent_cycle_check'
        ) order by proname`,
    );
    console.log(`\n--- functions (${fns.rows.length}) ---`);
    for (const row of fns.rows) console.log(`  ${row.proname}`);

    const fk = await c.query(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname = 'specs_milestone_id_fkey' and conrelid = 'public.specs'::regclass`,
    );
    console.log(`\n--- specs.milestone_id FK (${fk.rows.length}) ---`);
    for (const row of fk.rows) console.log(`  ${row.conname} :: ${row.def}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
