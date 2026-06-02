import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const TID = "4f59a82d-5d62-4157-a662-4a9ef82e172a";

const { data: t } = await admin.from("tickets")
  .select("id, subject, status, tags, ai_turn_count, channel, customer_id, workspace_id, created_at, handled_by, assigned_to, active_playbook_id, escalated_to, escalation_reason")
  .eq("id", TID).single();
console.log("─── TICKET ───");
console.log(JSON.stringify(t, null, 2));

const { data: msgs } = await admin.from("ticket_messages")
  .select("created_at, direction, author_type, visibility, body_clean, body, pending_send_at, sent_at, send_cancelled")
  .eq("ticket_id", TID).order("created_at");
console.log(`\n─── MESSAGES (${msgs?.length || 0}) ───`);
for (const m of msgs || []) {
  const time = new Date(m.created_at).toLocaleString();
  const role = m.author_type || m.direction;
  const vis = m.visibility === "internal" ? "[internal]" : "";
  const status = m.send_cancelled ? "[cancelled]" : m.pending_send_at ? `[pending]` : m.sent_at ? "[sent]" : "";
  const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n${time} ${role} ${vis} ${status}`);
  console.log(`  ${txt.slice(0, 600)}`);
}
