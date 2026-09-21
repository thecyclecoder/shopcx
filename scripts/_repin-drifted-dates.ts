/**
 * Re-time every shopcx sub whose Shopify-visible date has drifted from ours.
 *
 * The renewal advance pinned the cycle SCHEDULE but never moved the contract's `nextBillingDate`,
 * which is an independent storage field and the one the customer sees — so a charged sub sat
 * exactly one interval out. Fixed in the worker; this repairs the rows already charged.
 *
 * Idempotent: `shopifyRetimeContract` writes the date we already hold, so a correct row is a no-op.
 *
 *   npx tsx scripts/_repin-drifted-dates.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { reconcileShopcxDrift } from "../src/lib/commerce/shopcx-drift-reconciler";
import { shopifyRetimeContract } from "../src/lib/commerce/shopify-subscription-client";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const r = await reconcileShopcxDrift(WS, {});
  const dates = r.drift.filter((d) => d.kind === "date");
  console.log(`date drift: ${dates.length} of ${r.checked} checked`);

  for (const d of dates) {
    const { data: sub } = await admin.from("subscriptions")
      .select("next_billing_date, status")
      .eq("workspace_id", WS).eq("shopify_contract_id", d.contractId).maybeSingle();
    if (!sub?.next_billing_date) { console.log(`  skip ${d.contractId}: no date`); continue; }
    // A paused sub gets its date from portal-auto-resume's retimeAfterResume when it wakes.
    if (sub.status === "paused") { console.log(`  skip ${d.contractId}: paused — resume will retime it`); continue; }
    if (!APPLY) { console.log(`  [dry] ${d.contractId} → ${String(sub.next_billing_date).slice(0,10)}`); continue; }
    const res = await shopifyRetimeContract(WS, d.contractId, sub.next_billing_date);
    console.log(`  ${d.contractId} → ${String(sub.next_billing_date).slice(0,10)}: ${res.stranded ? "⚠️ STRANDED" : res.success ? "ok" : "✗ " + res.error}`);
  }
  if (!APPLY) { console.log("\ndry run — pass --apply"); return; }

  const after = await reconcileShopcxDrift(WS, {});
  console.log(`\nafter: drift=${after.drift.length}/${after.checked}`);
  for (const d of after.drift) console.log(`  [${d.kind}] ${d.contractId}: ${d.detail.slice(0,80)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
