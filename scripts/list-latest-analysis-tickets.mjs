import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: notif } = await admin
  .from("dashboard_notifications")
  .select("metadata, created_at")
  .eq("workspace_id", W)
  .filter("metadata->>type", "eq", "ai_nightly_analysis")
  .order("created_at", { ascending: false })
  .limit(1)
  .single();
const ids = notif?.metadata?.ticket_ids || [];
console.log(`Most recent analysis: ${notif.created_at}`);
console.log(`${ids.length} tickets analyzed:\n`);

// Tickets we already touched
const ALREADY_FIXED = new Set([
  // Sarah Young chain (agent_intervened propagation fix)
  "4843f560-f888-4353-b31b-9672d26a0af2",
  "08dba9c1-2ebf-47d5-b676-ea4431243bbc",
  "c9eec6a0-7d7f-4467-91fb-d486bf9778a9",
  "361f75b2-44e5-4e1d-aea6-1f33f261db53",
  "8139f590-034f-41ac-b0dd-2c82b2e7b969",
  "b8bed7cb-508a-4dbc-ac4a-6772bcccee8e",
  // Coupon-apply ones (closed today)
  "981bf7c0-6d18-4f54-91aa-20862dc8e0ec",
  "6123836f-51d2-42dc-8d92-dc89edfc3795",
]);

for (let i = 0; i < ids.length; i++) {
  const tid = ids[i];
  const { data: t } = await admin
    .from("tickets")
    .select("subject, channel, status, customer_id, created_at, escalated_at, escalated_to, assigned_to, agent_intervened, tags")
    .eq("id", tid)
    .single();
  if (!t) { console.log(`  #${i + 1}: NOT FOUND (${tid})`); continue; }
  const { data: cust } = await admin.from("customers").select("first_name, last_name, email").eq("id", t.customer_id).maybeSingle();
  const known = ALREADY_FIXED.has(tid) ? " ⓘ already touched" : "";
  console.log(`  #${i + 1}: ${tid.slice(0, 8)}  ${t.channel}/${t.status}  ${(cust?.first_name || "?") + " " + (cust?.last_name || "")}${known}`);
  console.log(`     "${t.subject?.slice(0, 70)}"`);
  console.log(`     created=${t.created_at?.slice(0,10)}  esc=${t.escalated_at?.slice(0,16) || "—"}  intervened=${t.agent_intervened}  tags=${(t.tags||[]).slice(0,5).join(",")}`);
}
