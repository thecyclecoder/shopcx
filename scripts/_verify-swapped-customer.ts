/** End-to-end check that a swapped customer's portal + CS surfaces still work. */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSubscriptionContract } from "../src/lib/commerce/shopify-subscription-client";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OLD = process.argv[2] ?? "34524233901";
async function main() {
  const admin = createAdminClient();
  const { data: snap } = await admin.from("appstle_contract_snapshots")
    .select("migrated_to_contract_id, migration_completed_at").eq("workspace_id", WS).eq("appstle_contract_id", OLD).single();
  const newId = String(snap!.migrated_to_contract_id).replace("gid://shopify/SubscriptionContract/", "");
  console.log(`old=${OLD}  new=${newId}  completed=${snap!.migration_completed_at}`);

  // 1. exactly ONE row for this customer's subscription — not two
  const { data: rows } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, billing_source, status, next_billing_date, items, applied_discounts, customer_id, migrated_from_contract_id, delivery_price_cents, shipping_address")
    .eq("workspace_id", WS).or(`shopify_contract_id.eq.${OLD},shopify_contract_id.eq.${newId}`);
  console.log(`1. rows matching old-or-new: ${rows?.length} ${rows?.length === 1 ? "✅ one row, repointed" : "⚠️ duplicate"}`);
  const sub = rows?.[0];
  if (!sub) return;
  console.log(`   ${sub.shopify_contract_id}  ${sub.billing_source}/${sub.status}  due ${String(sub.next_billing_date).slice(0,10)}  from=${sub.migrated_from_contract_id}`);

  // 2. portal payload fields the pages actually select
  const items = (sub.items as any[]) ?? [];
  const disc = (sub.applied_discounts as any[]) ?? [];
  console.log(`2. portal fields: items=${items.length} discounts=${disc.length} shipping=${sub.shipping_address ? "yes" : "NO"} deliveryCents=${sub.delivery_price_cents}`);
  console.log(`   items: ${items.map((i) => `${i.title} x${i.quantity} @${(i.price_cents/100).toFixed(2)}`).join(" | ")}`);
  console.log(`   discounts: ${disc.map((d) => `${d.title} ${d.value}${d.valueType === "PERCENTAGE" ? "%" : "$"}`).join(" | ") || "none"}`);

  // 3. the live contract agrees
  const c = await getSubscriptionContract(WS, newId);
  console.log(`3. live contract: ${c.contract?.status} nextBilling=${String(c.contract?.nextBillingDate).slice(0,10)} lines=${c.contract?.lines.length}`);
  const liveTotal = (c.contract?.lines ?? []).reduce((t, l) => t + Math.round(parseFloat(l.lineDiscountedPrice ?? "0") * 100), 0);
  const ourTotal = items.reduce((t, i) => t + i.price_cents * i.quantity, 0);
  console.log(`   live charge ${(liveTotal/100).toFixed(2)} vs our mirror ${(ourTotal/100).toFixed(2)} ${Math.abs(liveTotal-ourTotal) <= 2 ? "✅ match" : "⚠️ MISMATCH"}`);

  // 4. Appstle side is actually stopped
  const { data: oldSnap } = await admin.from("appstle_contract_snapshots").select("status").eq("workspace_id", WS).eq("appstle_contract_id", OLD).single();
  console.log(`4. appstle snapshot status: ${oldSnap?.status} (cancel verified by executeMigration before stamping completed)`);

  // 5. CS surfaces: does the customer still resolve for the ticket/orchestrator path?
  const { data: cust } = await admin.from("customers").select("id, email, shopify_customer_id").eq("id", sub.customer_id!).single();
  const { count: tix } = await admin.from("tickets").select("*", { count: "exact", head: true }).eq("workspace_id", WS).eq("customer_id", sub.customer_id!);
  console.log(`5. CS: customer ${cust?.email} resolves, ${tix} ticket(s) linked — subscription_id joins unchanged (row id ${sub.id} never changed)`);

  // 6. did the drift reconciler find anything?
  const { reconcileShopcxDrift } = await import("../src/lib/commerce/shopcx-drift-reconciler");
  const r = await reconcileShopcxDrift(WS, {});
  const mine = r.drift.filter((d) => d.contractId === newId);
  console.log(`6. drift check: ${mine.length ? "⚠️ " + JSON.stringify(mine) : "✅ clean for this contract"} (cohort-wide drift=${r.drift.length}/${r.checked})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
