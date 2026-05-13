import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TICKET_ID = "b0d46e97-7a5e-453c-9fbf-957750802771";

const { data: ticket } = await admin
  .from("tickets")
  .select("id, workspace_id, customer_id, channel, status, subject, tags, handled_by, journey_id, escalation_reason, created_at, updated_at, email_message_id")
  .eq("id", TICKET_ID)
  .maybeSingle();
console.log("TICKET:", JSON.stringify(ticket, null, 2));
if (!ticket) process.exit(0);

const { data: customer } = await admin
  .from("customers")
  .select("id, email, first_name, last_name, shopify_customer_id")
  .eq("id", ticket.customer_id)
  .maybeSingle();
console.log("\nCUSTOMER:", customer);

const { data: msgs } = await admin
  .from("ticket_messages")
  .select("author_type, direction, visibility, body, body_clean, created_at")
  .eq("ticket_id", TICKET_ID)
  .order("created_at", { ascending: true });
console.log(`\n${msgs?.length} MESSAGES:`);
for (const m of msgs || []) {
  const b = (m.body_clean || m.body || "").replace(/\n+/g, " ").slice(0, 280);
  console.log(`  [${m.created_at}] ${m.author_type}/${m.direction}/${m.visibility}`);
  console.log(`    ${b}`);
}

// Active subs
const { data: subs } = await admin
  .from("subscriptions")
  .select("id, shopify_contract_id, appstle_subscription_id, status, items, next_billing_date, billing_interval_days")
  .eq("customer_id", ticket.customer_id)
  .order("created_at", { ascending: false });
console.log("\nSUBSCRIPTIONS:");
for (const s of subs || []) {
  console.log(`  id=${s.id} appstle=${s.appstle_subscription_id || s.shopify_contract_id} status=${s.status} next=${s.next_billing_date}`);
  for (const i of (s.items || [])) {
    console.log(`    - ${i.title || i.variant_title} (var=${i.variant_id}) x${i.quantity || 1}`);
  }
}

// Recent orders
const { data: orders } = await admin
  .from("orders")
  .select("id, shopify_order_id, order_number, financial_status, fulfillment_status, line_items, total_price_cents, created_at")
  .eq("customer_id", ticket.customer_id)
  .order("created_at", { ascending: false })
  .limit(3);
console.log("\nRECENT ORDERS:");
for (const o of orders || []) {
  console.log(`  #${o.order_number} shopify=${o.shopify_order_id} financial=${o.financial_status} fulfillment=${o.fulfillment_status} total=$${(o.total_price_cents/100).toFixed(2)} created=${o.created_at}`);
  for (const i of (o.line_items || [])) {
    console.log(`    - ${i.title || i.name} qty=${i.quantity}`);
  }
}

// Existing returns
const { data: returns } = await admin
  .from("return_requests")
  .select("id, status, shopify_order_id, items, tracking_number, label_url, refund_amount_cents, refund_status, created_at")
  .eq("customer_id", ticket.customer_id)
  .order("created_at", { ascending: false });
console.log("\nEXISTING RETURNS:");
for (const r of returns || []) {
  console.log(`  id=${r.id} status=${r.status} order=${r.shopify_order_id} label=${r.label_url?'yes':'no'} tracking=${r.tracking_number || '-'} refund=$${((r.refund_amount_cents||0)/100).toFixed(2)} refund_status=${r.refund_status} created=${r.created_at}`);
}

// Active crisis events
const { data: crises } = await admin
  .from("crisis_events")
  .select("id, name, status, affected_product_title, affected_variant_id, default_swap_title, default_swap_variant_id")
  .eq("workspace_id", ticket.workspace_id)
  .eq("status", "active");
console.log("\nACTIVE CRISES:");
for (const c of crises || []) console.log(`  ${c.id} ${c.name} - ${c.affected_product_title}`);

const { data: actions } = await admin
  .from("crisis_customer_actions")
  .select("id, crisis_id, segment, current_tier, paused_at, auto_resume, removed_item_at, auto_readd, ticket_id, subscription_id, original_item")
  .eq("customer_id", ticket.customer_id);
console.log("\nEXISTING CRISIS ACTIONS:");
for (const a of actions || []) console.log(JSON.stringify(a, null, 2));
