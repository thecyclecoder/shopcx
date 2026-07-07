// apply-order-refunds-migration — create public.order_refunds, the refund idempotency + mirror ledger
// the code merged in PR #1265 reads/writes but shipped no migration for. Idempotent (CREATE TABLE IF NOT
// EXISTS + CREATE INDEX IF NOT EXISTS + drop/create policy). Run against the pooler:
//   npx tsx scripts/apply-order-refunds-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260917120000_create_order_refunds.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='order_refunds'",
    );
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='order_refunds' order by indexname",
    );
    const { rows: rls } = await c.query(
      "select relrowsecurity as on from pg_class where relname='order_refunds'",
    );
    console.log(`✓ order_refunds present: ${t[0].n === 1} | RLS: ${rls[0]?.on} | indexes: ${idx.map((r:any)=>r.indexname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
