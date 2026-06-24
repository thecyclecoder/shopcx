// apply-pricing-rule-offers-migration — create the dynamic, time-boxed persist-to-renewal
// offer model (storefront-dynamic-renewal-offers spec, P1): the pricing_rule_offers child
// table + subscriptions.pricing_offer_id reference.
// Idempotent (CREATE TABLE/INDEX/POLICY IF NOT EXISTS, ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-pricing-rule-offers-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260624000000_pricing_rule_offers.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
      ["pricing_rule_offers"],
    );
    console.log(`✓ public.pricing_rule_offers has ${rows[0].n} columns`);
    const { rows: subCol } = await c.query(
      "select 1 from information_schema.columns where table_schema='public' and table_name='subscriptions' and column_name='pricing_offer_id'",
    );
    console.log(`✓ subscriptions.pricing_offer_id present: ${subCol.length === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
