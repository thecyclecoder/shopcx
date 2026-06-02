import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const CASES = [
  { name: "Sherri McNeely", email: "sherrisjunk@outlook.com" },
  { name: "Jennifer Lujan", email: "jenlujan@lujanlaw.com" },
];

for (const c of CASES) {
  const { data: cust } = await admin
    .from("customers")
    .select("id, email")
    .eq("workspace_id", W)
    .ilike("email", c.email)
    .single();
  console.log(`\n=== ${c.name} (${cust?.id}) ===`);

  const { data: subs } = await admin
    .from("subscriptions")
    .select("shopify_contract_id, status, next_billing_date, items, applied_discounts, updated_at")
    .eq("workspace_id", W)
    .eq("customer_id", cust.id)
    .order("updated_at", { ascending: false });
  for (const s of subs || []) {
    const items = (s.items||[]).map(i=>i.title||i.variantTitle).join(", ");
    console.log(`  ${s.shopify_contract_id} | ${s.status} | next ${s.next_billing_date?.slice(0,10)}`);
    console.log(`    items: ${items}`);
    console.log(`    applied_discounts: ${JSON.stringify(s.applied_discounts)}`);
  }

  // Loyalty coupons available for this customer
  const { data: lc } = await admin
    .from("loyalty_coupons")
    .select("code, discount_value, status, applied_to_contract_id, expires_at, created_at")
    .eq("workspace_id", W)
    .eq("customer_id", cust.id)
    .order("created_at", { ascending: false });
  console.log(`  Loyalty coupons: ${lc?.length || 0}`);
  for (const c of lc || []) {
    console.log(`    ${c.code} | $${c.discount_value} | ${c.status} | applied_to=${c.applied_to_contract_id} | expires=${c.expires_at?.slice(0,10)}`);
  }
}
