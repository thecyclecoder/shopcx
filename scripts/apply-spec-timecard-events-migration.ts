// apply-spec-timecard-events-migration — create public.spec_timecard_events, its
// lookup index, and its RLS policies so the Mario ledger has a place to write.
// Additive; idempotent.
//   npx tsx scripts/apply-spec-timecard-events-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20261001120000_spec_timecard_events.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='spec_timecard_events' order by ordinal_position",
    );
    console.log(
      "✓ columns present:",
      rows.map((r) => r.column_name),
    );
    const idx = await c.query(
      "select indexname from pg_indexes where schemaname='public' and tablename='spec_timecard_events' order by indexname",
    );
    console.log(
      "✓ indexes present:",
      idx.rows.map((r) => r.indexname),
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
