// apply-renewal-offer-lever-migration — add storefront_optimizer_policy.min_renewal_margin_pct
// (the Phase 2 floor) + seed the persist_to_renewal_offer chapter + its two component levers in
// the M2 taxonomy (docs/brain/specs/storefront-renewal-offer-lever.md). Idempotent — column adds
// use IF NOT EXISTS and lever seeds use ON CONFLICT DO NOTHING.
//   npx tsx scripts/apply-renewal-offer-lever-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260624140000_renewal_offer_lever.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: col } = await c.query(
      "select column_name from information_schema.columns where table_name='storefront_optimizer_policy' and column_name='min_renewal_margin_pct'",
    );
    console.log(`✓ storefront_optimizer_policy.min_renewal_margin_pct present: ${col.length === 1}`);
    const { rows: levers } = await c.query(
      "select lever_key from public.storefront_levers where lever_key in ('persist_to_renewal_offer','renewal_discount_pct','renewal_fixed_price') order by lever_key",
    );
    console.log("✓ renewal-offer lever taxonomy:", levers.map((r) => r.lever_key));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
