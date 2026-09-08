// apply-qb-inbound-shipment-snapshots-migration — create public.qb_inbound_shipment_snapshots,
// the close's third physical bucket (shipped to Amazon, not yet received).
// Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes + drop/create policy).
//   npx tsx scripts/apply-qb-inbound-shipment-snapshots-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261221120000_qb_inbound_shipment_snapshots.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int n from information_schema.columns where table_name='qb_inbound_shipment_snapshots'",
    );
    console.log(`✓ qb_inbound_shipment_snapshots columns: ${rows[0].n}`);
    const { rows: rls } = await c.query(
      "select relrowsecurity from pg_class where relname='qb_inbound_shipment_snapshots'",
    );
    console.log(`✓ RLS enabled: ${rls[0]?.relrowsecurity}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
