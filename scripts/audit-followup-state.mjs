import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const CUSTOMERS = [
  { name: "Marilyn", tid: "b99c9fec-a387-404c-b31b-2bff4494623c", email: "mnbuman@gmail.com" },
  { name: "Lynne", tid: "9bfce5c2-0e91-429a-806a-93054ef7d195", email: "lshovlain1@gmail.com" },
  { name: "Sheela", tid: "fadb5f01-7d7f-499e-af21-a144145d4e06", email: "whispyweeve@gmail.com" },
  { name: "Linda", tid: "9f53fde5-6164-428c-9805-6a4aa5624a29", email: "lindad1203@yahoo.com", orderNum: "SC129298" },
  { name: "Stephanie", tid: "61ca5299-a15f-4fe8-8348-cd651b8e668a", email: "faust.stephanie7@gmail.com" },
];

for (const c of CUSTOMERS) {
  const { data: ticket } = await admin.from("tickets").select("subject, customer_id, email_message_id, status").eq("id", c.tid).single();
  const { data: cust } = await admin.from("customers").select("id, email, first_name, shopify_customer_id, ltv_cents").eq("id", ticket?.customer_id).single();
  console.log(`\n══ ${c.name} ══  ${cust?.email}`);
  console.log(`  customer_id: ${cust?.id}  shopify_id: ${cust?.shopify_customer_id}  ltv: $${(cust?.ltv_cents || 0)/100}`);
  console.log(`  ticket: ${c.tid}  status=${ticket?.status}`);

  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date")
    .eq("customer_id", cust?.id).order("created_at", {ascending: false});
  console.log(`  ${subs?.length || 0} subs:`);
  for (const s of subs || []) {
    console.log(`    ${s.shopify_contract_id} ${s.status} every ${s.billing_interval_count} ${s.billing_interval} next=${s.next_billing_date?.slice(0,10)}`);
    for (const it of s.items || []) console.log(`      ${it.quantity}x ${it.title} ${it.variant_title || ""} v=${it.variant_id} price=${it.price_cents}`);
  }

  if (c.orderNum) {
    const { data: orders } = await admin.from("orders")
      .select("order_number, total_cents, line_items, financial_status, fulfillment_status, created_at, shopify_order_id, amplifier_order_id, amplifier_status")
      .eq("customer_id", cust?.id).eq("order_number", c.orderNum).maybeSingle();
    if (orders) {
      const ageHrs = ((Date.now() - new Date(orders.created_at).getTime())/1000/60/60).toFixed(1);
      console.log(`  Order ${orders.order_number}: ${orders.created_at?.slice(0,10)} (${ageHrs}h ago) shop_id=${orders.shopify_order_id} ${orders.financial_status}/${orders.fulfillment_status} amp=${orders.amplifier_status || "—"}`);
      for (const li of orders.line_items || []) console.log(`    ${li.quantity}x ${li.title} v=${li.variant_id || li.variantId}`);
    }
  }

  // Recent orders (in last 24h)
  const { data: recent } = await admin.from("orders")
    .select("order_number, total_cents, financial_status, created_at, shopify_order_id")
    .eq("customer_id", cust?.id).gte("created_at", new Date(Date.now() - 24*60*60*1000).toISOString())
    .order("created_at", {ascending: false});
  if (recent?.length) {
    console.log(`  ${recent.length} orders in last 24h:`);
    for (const r of recent) console.log(`    ${r.order_number} ${r.created_at?.slice(0,16)} $${(r.total_cents/100).toFixed(2)} ${r.financial_status}`);
  }
}
