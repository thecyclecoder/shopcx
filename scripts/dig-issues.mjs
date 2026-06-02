import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const TIDS = [
  { id: "c00853c8-48d3-4a70-b520-9967b3ccdbee", flag: "#3 robotic / returns" },
  { id: "5e6b5b11-a09d-4fe2-b3b1-2e0adf7daa0b", flag: "#9 inaccuracy / 30 vs 3-month pause" },
  { id: "e53c9d04-eb1e-4b2a-b542-98423bc927ce", flag: "#10 inaccuracy / sub-status / return" },
  { id: "46e33657-6962-4d35-84d1-8aba5760e0b3", flag: "#11 generic / email + points" },
];

for (const { id, flag } of TIDS) {
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`${flag}  ${id}`);
  console.log(`══════════════════════════════════════════════`);
  const { data: t } = await admin.from("tickets")
    .select("subject, status, tags, ai_turn_count, channel, customer_id, active_playbook_id, escalation_reason")
    .eq("id", id).single();
  console.log(`subject: ${t?.subject}  status=${t?.status}  channel=${t?.channel}  turns=${t?.ai_turn_count}`);
  console.log(`tags: ${(t?.tags || []).join(", ")}`);

  const { data: msgs } = await admin.from("ticket_messages")
    .select("created_at, direction, author_type, visibility, body, body_clean, send_cancelled, pending_send_at")
    .eq("ticket_id", id).order("created_at");
  for (const m of msgs || []) {
    const role = m.author_type || m.direction;
    const vis = m.visibility === "internal" ? "[internal]" : "";
    const cancelled = m.send_cancelled ? "[CANCELLED]" : "";
    const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
    console.log(`\n${m.created_at?.slice(11,19)} ${role} ${vis} ${cancelled}`);
    console.log(`  ${txt.slice(0, 500)}${txt.length > 500 ? "...(trunc)" : ""}`);
  }
}
