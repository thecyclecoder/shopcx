// _verify-spec-timecard-events-schema — print the live columns, indexes, and policies
// on public.spec_timecard_events so a human (or the spec's Verification step) can
// eyeball them against the migration. Read-only.
//   npx tsx scripts/_verify-spec-timecard-events-schema.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const cols = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='spec_timecard_events'
        order by ordinal_position`,
    );
    console.log(`columns: ${cols.rows.length}`);
    for (const r of cols.rows) console.log(`  ${r.column_name}  ${r.data_type}  ${r.is_nullable === "YES" ? "null" : "not null"}`);

    const idx = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='spec_timecard_events' order by indexname`,
    );
    console.log(`\nindexes: ${idx.rows.length}`);
    for (const r of idx.rows) console.log(`  ${r.indexname}`);

    const pol = await c.query(
      `select policyname from pg_policies where schemaname='public' and tablename='spec_timecard_events' order by policyname`,
    );
    console.log(`\npolicies: ${pol.rows.length}`);
    for (const r of pol.rows) console.log(`  ${r.policyname}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
