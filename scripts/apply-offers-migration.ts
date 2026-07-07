// apply-offers-migration — create public.offers, the admin-layer attach-extra-
// items table for Phase 1 of offer-creator. Idempotent (CREATE TABLE IF NOT
// EXISTS + CREATE INDEX IF NOT EXISTS + drop/create constraint + drop/create
// policy). Run against the pooler:
//   npx tsx scripts/apply-offers-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260925120000_create_offers.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='offers'",
    );
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='offers' order by ordinal_position",
    );
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='offers' order by indexname",
    );
    const { rows: rls } = await c.query(
      "select relrowsecurity as on from pg_class where relname='offers'",
    );
    console.log(
      `✓ offers present: ${t[0].n === 1} | RLS: ${rls[0]?.on} | columns: ${cols
        .map((r: { column_name: string }) => r.column_name)
        .join(", ")} | indexes: ${idx.map((r: { indexname: string }) => r.indexname).join(", ")}`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
