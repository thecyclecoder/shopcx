/**
 * Ship-time backfill: internal subs whose `billing_source` still carries the column DEFAULT.
 *
 * `subscriptions.billing_source` was added with DEFAULT 'appstle' and backfilled once. Inserts
 * that omitted it (the storefront checkout, and `buildCreateSubscriptionRow`) have been writing
 * `is_internal = true` + `billing_source = 'appstle'` ever since. Harmless while every selector
 * keyed on `is_internal`; NOT harmless now that they key on `billing_source` — the
 * migrate-to-internal sweep (which runs on portal page load) would re-migrate them.
 *
 * Idempotent: matches only the mismatch, so a re-run is a no-op.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

async function main() {
  const admin = (await import("../src/lib/supabase/admin")).createAdminClient();
  const { data: before } = await admin
    .from("subscriptions").select("id, status, shopify_contract_id")
    .eq("is_internal", true).eq("billing_source", "appstle");
  console.log(`internal subs mis-tagged 'appstle': ${before?.length ?? 0}`);
  for (const r of before ?? []) console.log(`  ${r.id} ${r.status} ${r.shopify_contract_id}`);
  if (!before?.length) { console.log("nothing to do"); return; }

  const { data: after, error } = await admin
    .from("subscriptions")
    .update({ billing_source: "internal", updated_at: new Date().toISOString() })
    .eq("is_internal", true).eq("billing_source", "appstle")
    .select("id");
  if (error) { console.error("backfill failed:", error.message); process.exit(1); }
  console.log(`retagged: ${after?.length ?? 0}`);

  const { count } = await admin.from("subscriptions")
    .select("id", { count: "exact", head: true }).eq("is_internal", true).eq("billing_source", "appstle");
  console.log(`remaining mismatch (must be 0): ${count}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
