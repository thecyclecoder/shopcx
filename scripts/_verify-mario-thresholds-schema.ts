// _verify-mario-thresholds-schema — print the live columns, indexes/constraints,
// and policies on public.mario_thresholds so a human (or the spec's Verification
// step) can eyeball them against the migration. Read-only.
//   npx tsx scripts/_verify-mario-thresholds-schema.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const cols = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='mario_thresholds'
        order by ordinal_position`,
    );
    console.log(`columns: ${cols.rows.length}`);
    for (const r of cols.rows) console.log(`  ${r.column_name}  ${r.data_type}  ${r.is_nullable === "YES" ? "null" : "not null"}`);

    const idx = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='mario_thresholds' order by indexname`,
    );
    console.log(`\nindexes: ${idx.rows.length}`);
    for (const r of idx.rows) console.log(`  ${r.indexname}`);

    const uniq = await c.query(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'public.mario_thresholds'::regclass
          and contype in ('u','p','f')
        order by conname`,
    );
    console.log(`\nconstraints: ${uniq.rows.length}`);
    for (const r of uniq.rows) console.log(`  ${r.conname}  ${r.def}`);

    const pol = await c.query(
      `select policyname from pg_policies where schemaname='public' and tablename='mario_thresholds' order by policyname`,
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
