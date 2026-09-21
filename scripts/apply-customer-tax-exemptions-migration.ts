// apply-customer-tax-exemptions-migration — create public.customer_tax_exemptions +
// the per-customer read index and the partial UNIQUE (customer_id, jurisdiction_region)
// WHERE revoked_at IS NULL live-certificate invariant index.
//
// Phase 1 of docs/brain/specs/a-customer-can-be-recorded-as-sales-tax-exempt.md.
// Idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS + IF NOT EXISTS on constraints).
// Run against the pooler:
//   npx tsx scripts/apply-customer-tax-exemptions-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20270101120000_customer_tax_exemptions.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='customer_tax_exemptions'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("customer_tax_exemptions table missing after migration");
    console.log(`✓ customer_tax_exemptions has ${cols.length} column(s):`);
    for (const col of cols) {
      console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);
    }

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='customer_tax_exemptions'
        order by indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    const need = [
      "customer_tax_exemptions_workspace_customer_recorded_at_idx",
      "customer_tax_exemptions_customer_region_live_uidx",
    ];
    for (const n of need) {
      if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    }
    console.log(`✓ indexes present: ${need.join(", ")}`);

    const { rows: rls } = await c.query(
      `select relrowsecurity from pg_class
        where oid = 'public.customer_tax_exemptions'::regclass`,
    );
    if (!rls[0]?.relrowsecurity) throw new Error("RLS not enabled on customer_tax_exemptions");
    console.log("✓ RLS enabled");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
