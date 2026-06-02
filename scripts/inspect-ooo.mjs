import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const TID = "53c88f76-1ac2-4bd7-a3ad-53a888a95dd3";

const { data: t } = await admin.from("tickets")
  .select("id, subject, status, tags, ai_turn_count, channel, customer_id, workspace_id, created_at, handled_by, assigned_to, active_playbook_id, escalation_reason")
  .eq("id", TID).single();
console.log(JSON.stringify(t, null, 2));

const { data: msgs } = await admin.from("ticket_messages")
  .select("created_at, direction, author_type, visibility, body_clean, body, send_cancelled")
  .eq("ticket_id", TID).order("created_at");
console.log(`\n${msgs?.length || 0} messages:`);
for (const m of msgs || []) {
  const role = m.author_type || m.direction;
  const vis = m.visibility === "internal" ? "[internal]" : "";
  const cancelled = m.send_cancelled ? "[CANCELLED]" : "";
  const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n${m.created_at?.slice(11,19)} ${role} ${vis} ${cancelled}`);
  console.log(`  ${txt.slice(0, 800)}${txt.length > 800 ? "..." : ""}`);
}
