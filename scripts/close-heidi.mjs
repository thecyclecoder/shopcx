import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "16bcd9ec-861a-4119-82fa-d836f21ac743";

// Verify her subs
const { data: cust } = await admin
  .from("customers")
  .select("id")
  .eq("workspace_id", W)
  .ilike("email", "heidela2000@yahoo.com")
  .single();
const { data: subs } = await admin
  .from("subscriptions")
  .select("shopify_contract_id, status, items, updated_at")
  .eq("workspace_id", W)
  .eq("customer_id", cust.id)
  .order("updated_at", { ascending: false });
console.log("Heidi subs:");
for (const s of subs || []) {
  const items = (s.items || []).map(i => i.title || i.variantTitle).join(", ");
  console.log(`  ${s.shopify_contract_id}  ${s.status}  ${items}  updated ${s.updated_at?.slice(0,10)}`);
}

const allCancelled = (subs || []).every(s => s.status === "cancelled");
console.log(`\nAll cancelled? ${allCancelled}`);

if (process.argv.includes("--apply") && allCancelled) {
  await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] Operator closed: subscription was already cancelled prior to migration. No customer-facing action needed.`,
  });
  await admin
    .from("tickets")
    .update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", TICKET_ID);
  console.log("✓ ticket closed");
}
