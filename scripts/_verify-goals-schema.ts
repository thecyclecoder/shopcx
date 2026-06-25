// _verify-goals-schema — read-only probe that prints the live shape of public.goals +
// public.goal_milestones + the specs.milestone_id FK constraint + the rollup triggers /
// functions, so the spec's completion criteria can be eyeballed against the migration.
//   npx tsx scripts/_verify-goals-schema.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const table of ["goals", "goal_milestones"]) {
      const cols = await c.query(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema='public' and table_name=$1
          order by ordinal_position`,
        [table],
      );
      console.log(`\n[${table}] columns: ${cols.rows.length}`);
      for (const r of cols.rows) {
        console.log(`  ${r.column_name.padEnd(22)} ${r.data_type.padEnd(28)} nullable=${r.is_nullable}`);
      }

      const idx = await c.query(
        `select indexname, indexdef from pg_indexes
          where schemaname='public' and tablename=$1
          order by indexname`,
        [table],
      );
      console.log(`[${table}] indexes: ${idx.rows.length}`);
      for (const r of idx.rows) console.log(`  ${r.indexname}`);

      const pol = await c.query(
        `select policyname, cmd from pg_policies where schemaname='public' and tablename=$1 order by policyname`,
        [table],
      );
      console.log(`[${table}] policies: ${pol.rows.length}`);
      for (const r of pol.rows) console.log(`  ${r.policyname} (${r.cmd})`);
    }

    const fk = await c.query(
      `select tc.constraint_name, rc.delete_rule, ccu.table_name as ref_table, ccu.column_name as ref_col
         from information_schema.table_constraints tc
         join information_schema.referential_constraints rc on rc.constraint_name=tc.constraint_name
         join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name
        where tc.table_schema='public' and tc.table_name='specs'
          and tc.constraint_name='specs_milestone_id_fkey'`,
    );
    console.log(`\n[specs.milestone_id FK] rows: ${fk.rows.length}`);
    for (const r of fk.rows) {
      console.log(`  ${r.constraint_name} → ${r.ref_table}(${r.ref_col}) on delete ${r.delete_rule}`);
    }

    const fns = await c.query(
      `select proname from pg_proc where proname in (
         'roll_up_milestone_status','roll_up_goal_status',
         'specs_milestone_rollup_trigger','goal_milestones_rollup_trigger','goals_no_cycle_trigger'
       ) order by proname`,
    );
    console.log(`\nrollup/cycle functions: ${fns.rows.length}`);
    for (const r of fns.rows) console.log(`  ${r.proname}`);

    const trigs = await c.query(
      `select tgname, tgrelid::regclass::text as on_table, pg_get_triggerdef(oid) as def
         from pg_trigger
        where tgname in ('specs_milestone_rollup','goal_milestones_rollup','goals_no_cycle')
          and not tgisinternal
        order by tgname`,
    );
    console.log(`\nrollup/cycle triggers: ${trigs.rows.length}`);
    for (const r of trigs.rows) console.log(`  ${r.tgname.padEnd(28)} on ${r.on_table}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
