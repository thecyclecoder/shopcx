/**
 * Re-mirror `subscriptions.items` from the live contract for every MIGRATED shopcx sub.
 *
 * The migration swap repointed the row and flipped the engine but never refreshed `items`, so a
 * migrated row kept its Appstle-era prices. Wave 1: 13 of 25 rows showed the customer a price
 * HIGHER than their contract charges (up to $43.13 out) — the pricing correction the migration had
 * just applied and never mirrored. Errs in the customer's favour, which is why nothing complained.
 *
 * Idempotent: it rewrites `items` from the contract every time, so re-running is a no-op in effect.
 * Reads SHOPIFY only — no Appstle calls.
 *
 *   npx tsx scripts/_backfill-migrated-pricing-mirror.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { mirrorContractPricing } from "../src/lib/commerce/shopcx-contract-ingest";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data: workspaces } = await admin
    .from("workspaces").select("id").not("shopify_access_token_encrypted", "is", null);

  for (const w of workspaces ?? []) {
    const { data: rows } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, migrated_from_contract_id, items")
      .eq("workspace_id", w.id)
      .eq("billing_source", "shopcx")
      .not("migrated_from_contract_id", "is", null);
    if (!rows?.length) continue;
    console.log(`${w.id}: ${rows.length} migrated row(s)`);

    let changed = 0;
    for (const r of rows) {
      const before = ((r.items as { price_cents: number; quantity: number }[]) ?? [])
        .reduce((t, i) => t + i.price_cents * i.quantity, 0);
      if (!APPLY) { console.log(`  [dry] ${r.shopify_contract_id} currently $${(before / 100).toFixed(2)}`); continue; }

      const m = await mirrorContractPricing(w.id, r.shopify_contract_id);
      if (!m.ok) { console.error(`  ✗ ${r.shopify_contract_id}: ${m.error}`); continue; }

      const { data: after } = await admin.from("subscriptions").select("items").eq("id", r.id).single();
      const now = ((after?.items as { price_cents: number; quantity: number }[]) ?? [])
        .reduce((t, i) => t + i.price_cents * i.quantity, 0);
      if (Math.abs(now - before) > 2) {
        changed++;
        console.log(`  ${r.shopify_contract_id}: $${(before / 100).toFixed(2)} → $${(now / 100).toFixed(2)}`);
      }
    }
    if (APPLY) console.log(`  ${changed} row(s) corrected`);
  }
  if (!APPLY) console.log("\ndry run — pass --apply to write");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
