import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: notif } = await admin
  .from("dashboard_notifications")
  .select("metadata")
  .eq("workspace_id", W)
  .filter("metadata->>type", "eq", "ai_nightly_analysis")
  .order("created_at", { ascending: false })
  .limit(1)
  .single();

const ids = notif?.metadata?.ticket_ids || [];
console.log("Ticket IDs in last analysis:", ids);

for (let i = 0; i < ids.length; i++) {
  const tid = ids[i];
  const { data: t } = await admin
    .from("tickets")
    .select("id, subject, channel, status, handled_by, customer_id, created_at, ai_turn_count, escalated_to, escalation_reason")
    .eq("id", tid)
    .single();
  if (!t) {
    console.log(`  #${i + 1}: NOT FOUND (${tid})`);
    continue;
  }
  const { data: cust } = await admin.from("customers").select("first_name, last_name, email").eq("id", t.customer_id).maybeSingle();
  console.log(`\n  #${i + 1}: ${tid}`);
  console.log(`    "${t.subject}"`);
  console.log(`    ${t.channel} | ${t.status} | handled_by=${t.handled_by} | turns=${t.ai_turn_count} | escalated=${t.escalated_to || "—"} ${t.escalation_reason ? `(${t.escalation_reason})` : ""}`);
  console.log(`    customer: ${cust?.first_name} ${cust?.last_name} <${cust?.email}>`);
  console.log(`    created: ${t.created_at}`);
}
