import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "/Users/admin/Projects/shopcx/scripts/env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const CUSTOMER_ID = "0c825e4b-30fc-42ad-8ecb-fecdcd6ce794";
const CONTRACT = "27967684781";

const { data: cust } = await admin.from("customers").select("id, email, first_name, last_name, shopify_customer_id").eq("id", CUSTOMER_ID).single();
console.log("Customer:", JSON.stringify(cust, null, 2));

const { data: subs } = await admin.from("subscriptions")
  .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, applied_discounts, created_at, total_price_cents, customer_id, shopify_customer_id")
  .or(`customer_id.eq.${CUSTOMER_ID},shopify_customer_id.eq.${cust.shopify_customer_id}`);
console.log(`${subs?.length || 0} subs found by either id`);
const sub = subs?.find(s => s.shopify_contract_id === CONTRACT) || subs?.[0];
if (!sub) { console.log("no sub found, exiting"); process.exit(0); }
console.log("\nSubscription:");
console.log(`  created=${sub.created_at?.slice(0,10)} status=${sub.status} every ${sub.billing_interval_count} ${sub.billing_interval}`);
console.log(`  total_price_cents=${sub.total_price_cents}`);
console.log(`  applied_discounts=${JSON.stringify(sub.applied_discounts)}`);
console.log(`  items:`);
for (const it of sub.items || []) console.log(`    ${JSON.stringify(it)}`);

// Pull orders containing the same variant
const { data: orders } = await admin.from("orders")
  .select("order_number, created_at, total_cents, line_items, financial_status, source_name, tags")
  .eq("customer_id", CUSTOMER_ID)
  .order("created_at", { ascending: false })
  .limit(20);
console.log(`\n${orders?.length || 0} orders (newest first):`);
for (const o of orders || []) {
  console.log(`  ${o.order_number}  ${o.created_at?.slice(0,10)}  $${(o.total_cents/100).toFixed(2)}  src=${o.source_name || "(none)"}  tags=${(o.tags || []).join(",")}`);
  for (const li of (o.line_items || [])) {
    const isHazelnut = li.variant_id === "42614446489773" || /hazelnut/i.test(li.variant_title || "") || /hazelnut/i.test(li.title || "");
    if (!isHazelnut) continue;
    console.log(`    ${li.quantity}x ${li.title}/${li.variant_title || ""}  variant=${li.variant_id}  price_cents=${li.price_cents}  sku=${li.sku}`);
  }
}
