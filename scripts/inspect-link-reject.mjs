// Inspect ticket where Opus didn't handle account-linking rejection
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const TID = "342996cd-4ecd-4886-832e-5e634ab12d30";

const { data: t } = await admin.from("tickets")
  .select("id, subject, status, tags, ai_turn_count, channel, customer_id, workspace_id, created_at, handled_by, assigned_to, journey_id, journey_step, journey_data, active_playbook_id")
  .eq("id", TID).single();
console.log("─── TICKET ───");
console.log(JSON.stringify(t, null, 2));

const { data: msgs } = await admin.from("ticket_messages")
  .select("created_at, direction, author_type, visibility, body_clean, body")
  .eq("ticket_id", TID).order("created_at", { ascending: true });

console.log(`\n─── MESSAGES (${msgs?.length || 0}) ───`);
for (const m of msgs || []) {
  const time = new Date(m.created_at).toLocaleString();
  const role = m.author_type || m.direction;
  const vis = m.visibility === "internal" ? "[internal]" : "";
  const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n${time} ${role} ${vis}`);
  console.log(`  ${txt.slice(0, 1200)}${txt.length > 1200 ? "...(trunc)" : ""}`);
}

// Check journey sessions
const { data: sessions } = await admin.from("journey_sessions")
  .select("id, trigger_intent, status, responses, created_at")
  .eq("ticket_id", TID)
  .order("created_at");
console.log(`\n─── JOURNEY SESSIONS (${sessions?.length || 0}) ───`);
for (const s of sessions || []) {
  console.log(`  ${s.created_at} ${s.trigger_intent} ${s.status}`);
  console.log(`    responses: ${JSON.stringify(s.responses || {}).slice(0, 400)}`);
}

// Check customer link rejections
if (t?.customer_id) {
  const { data: rejections } = await admin.from("customer_link_rejections")
    .select("rejected_email, created_at")
    .eq("customer_id", t.customer_id);
  console.log(`\n─── LINK REJECTIONS for customer (${rejections?.length || 0}) ───`);
  for (const r of rejections || []) console.log(`  ${r.created_at}  ${r.rejected_email}`);
}
