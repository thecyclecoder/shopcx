// apply-digital-good-deliveries-migration — create public.digital_good_deliveries,
// the delivery LEDGER + idempotency guard for Phase 2 of digital-goods-delivery.
// Idempotent (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + drop/create
// policy). Run against the pooler:
//   npx tsx scripts/apply-digital-good-deliveries-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260924120000_create_digital_good_deliveries.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='digital_good_deliveries'",
    );
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='digital_good_deliveries' order by ordinal_position",
    );
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='digital_good_deliveries' order by indexname",
    );
    const { rows: rls } = await c.query(
      "select relrowsecurity as on from pg_class where relname='digital_good_deliveries'",
    );
    console.log(
      `✓ digital_good_deliveries present: ${t[0].n === 1} | RLS: ${rls[0]?.on} | columns: ${cols
        .map((r: any) => r.column_name)
        .join(", ")} | indexes: ${idx.map((r: any) => r.indexname).join(", ")}`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
