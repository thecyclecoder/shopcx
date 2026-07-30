import { createAdminClient } from "./_bootstrap";
import { linkGroupIds } from "../src/lib/customer-links";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_CUSTOMER = "98f54a3e-a256-4b98-843a-d0e5a27c5a51";

async function main() {
  const admin = createAdminClient();
  const { data: sample } = await admin.from("journey_definitions").select("*").limit(1);
  console.log("journey_definitions cols:", Object.keys(sample?.[0] || {}).join(", "));

  const { data } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent, is_active, workspace_id, match_patterns")
    .eq("workspace_id", WORKSPACE);
  console.log("\n=== journeys for workspace ===");
  for (const j of data || []) console.log(JSON.stringify(j));

  // Confirm subs resolve across the link group
  console.log("\n=== active subs across Julie's link group ===");
  const ids = await linkGroupIds(admin, WORKSPACE, TICKET_CUSTOMER);
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, customer_id, shopify_contract_id, status, items")
    .in("customer_id", ids)
    .eq("status", "active");
  for (const s of subs || []) console.log(JSON.stringify({ id: s.id, cust: s.customer_id, contract: s.shopify_contract_id, items: (s.items as any[])?.map((i) => `${i.quantity}x ${i.title}`) }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
