import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const TID = "f49d7e50-33d1-4e6a-8935-3fb71b3b7b69";

const { data: t } = await admin.from("tickets")
  .select("id, subject, status, tags, ai_turn_count, channel, customer_id, workspace_id")
  .eq("id", TID).single();
console.log("─── TICKET ───");
console.log(JSON.stringify(t, null, 2));

const { data: msgs } = await admin.from("ticket_messages")
  .select("created_at, direction, author_type, visibility, body, body_clean")
  .eq("ticket_id", TID).order("created_at");
console.log(`\n${msgs?.length || 0} messages:`);
for (const m of msgs || []) {
  const role = m.author_type || m.direction;
  const vis = m.visibility === "internal" ? "[internal]" : "";
  const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n${m.created_at?.slice(11,19)} ${role} ${vis}`);
  console.log(`  ${txt.slice(0, 800)}`);
}

if (t?.customer_id) {
  const { data: c } = await admin.from("customers").select("id, email, first_name, last_name, shopify_customer_id, ltv_cents").eq("id", t.customer_id).single();
  console.log("\nCustomer:", JSON.stringify(c, null, 2));

  const { data: subs } = await admin.from("subscriptions").select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date").eq("customer_id", t.customer_id);
  console.log(`\n${subs?.length || 0} subscriptions:`);
  for (const s of subs || []) {
    console.log(`\n  ${s.shopify_contract_id}  status=${s.status}  interval=${s.billing_interval_count} ${s.billing_interval}  next=${s.next_billing_date?.slice(0,10)}`);
    for (const it of (s.items || [])) {
      console.log(`    ${it.quantity || 1}x ${it.title}  variant=${it.variant_id || it.variantId}  sku=${it.sku || "?"}`);
    }
  }
}
