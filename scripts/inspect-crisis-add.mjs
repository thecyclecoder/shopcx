import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TICKET_ID = "01b783e1-41cc-4df5-aac8-9dcee28939fb";

const { data: ticket } = await admin
  .from("tickets")
  .select("id, subject, status, channel, customer_id, customer_email, handled_by, tags, escalation_reason, journey_id, created_at, updated_at")
  .eq("id", TICKET_ID)
  .maybeSingle();
console.log("TICKET:");
console.log(JSON.stringify(ticket, null, 2));

if (!ticket?.customer_id) { console.log("\n(no customer linked)"); process.exit(0); }

// Customer
const { data: customer } = await admin
  .from("customers")
  .select("id, email, first_name, last_name")
  .eq("id", ticket.customer_id)
  .maybeSingle();
console.log("\nCUSTOMER:", customer);

// Linked customer profiles
const { data: linkRows } = await admin
  .from("customer_links")
  .select("customer_id, group_id")
  .eq("customer_id", ticket.customer_id);
const groupIds = (linkRows || []).map(r => r.group_id);
const linkedIds = new Set([ticket.customer_id]);
if (groupIds.length) {
  const { data: members } = await admin.from("customer_links").select("customer_id").in("group_id", groupIds);
  for (const m of members || []) linkedIds.add(m.customer_id);
}
console.log(`\nLinked customer profiles: ${Array.from(linkedIds).length}`);

// Active crisis events
const { data: crises } = await admin
  .from("crisis_events")
  .select("id, name, status, affected_product_title")
  .eq("workspace_id", ticket.workspace_id || "fdc11e10-b89f-4989-8b73-ed6526c4d906")
  .order("created_at", { ascending: false })
  .limit(10);
console.log("\nCRISES (last 10):");
for (const c of crises || []) console.log(`  ${c.id} ${c.name} [${c.status}] product=${c.affected_product_title}`);

// Crisis customer actions
const { data: actions } = await admin
  .from("crisis_customer_actions")
  .select("crisis_id, customer_id, segment, current_tier, paused_at, auto_resume, removed_item_at, auto_readd, tier1_response, tier1_swapped_to, ticket_id, created_at, updated_at")
  .in("customer_id", Array.from(linkedIds));
console.log(`\nCRISIS_CUSTOMER_ACTIONS for this customer / linked group: ${actions?.length || 0}`);
for (const a of actions || []) {
  console.log(JSON.stringify(a, null, 2));
}

// Subscriptions
const { data: subs } = await admin
  .from("subscriptions")
  .select("id, status, items, next_billing_date")
  .in("customer_id", Array.from(linkedIds))
  .order("created_at", { ascending: false })
  .limit(5);
console.log("\nSUBSCRIPTIONS:");
for (const s of subs || []) {
  console.log(`  ${s.id} status=${s.status} next=${s.next_billing_date}`);
  const items = (s.items || []).map(i => `${i.title || i.variant_title || "?"} x${i.quantity || 1}`);
  console.log(`    items: ${items.join(", ")}`);
}
