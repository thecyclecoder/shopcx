import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const TID = "528f6ed9-66fb-47c3-be28-eea76a7bd957";

const { data: t } = await admin.from("tickets")
  .select("id, subject, status, tags, ai_turn_count, channel, customer_id, workspace_id, created_at, handled_by, assigned_to, active_playbook_id, playbook_step, playbook_context, playbook_exceptions_used, playbook_queue, escalated_to, escalation_reason")
  .eq("id", TID).single();
console.log("─── TICKET ───");
console.log(JSON.stringify(t, null, 2));

if (t?.active_playbook_id) {
  const { data: pb } = await admin.from("playbooks").select("name, trigger_intents").eq("id", t.active_playbook_id).single();
  console.log(`\nActive playbook: ${pb?.name} (intents: ${JSON.stringify(pb?.trigger_intents)})`);
}

const { data: msgs } = await admin.from("ticket_messages")
  .select("created_at, direction, author_type, visibility, body_clean, body, pending_send_at, sent_at, send_cancelled")
  .eq("ticket_id", TID).order("created_at", { ascending: true });

console.log(`\n─── MESSAGES (${msgs?.length || 0}) ───`);
for (const m of msgs || []) {
  const time = new Date(m.created_at).toLocaleString();
  const role = m.author_type || m.direction;
  const vis = m.visibility === "internal" ? "[internal]" : "";
  const status = m.send_cancelled ? "[cancelled]" : m.pending_send_at ? `[pending ${m.pending_send_at}]` : m.sent_at ? "[sent]" : "";
  const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n${time} ${role} ${vis} ${status}`);
  console.log(`  ${txt.slice(0, 800)}`);
}
