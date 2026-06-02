import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TID = process.argv[2];
if (!TID) { console.error("Usage: node show-ticket.mjs <ticket_id>"); process.exit(1); }

const { data: t } = await admin
  .from("tickets")
  .select("id, subject, channel, status, customer_id, created_at, tags, ai_turn_count, ai_clarification_turns, ai_detected_intent, ai_intent_confidence, escalated_to, escalation_reason, journey_id, journey_step")
  .eq("id", TID)
  .single();

const { data: cust } = await admin.from("customers").select("*").eq("id", t.customer_id).single();
const customerName = `${cust?.first_name || ""} ${cust?.last_name || ""}`.trim();

console.log(`\n=== ${customerName} <${cust?.email}> ===`);
console.log(`Ticket: ${t.id}`);
console.log(`Subject: ${t.subject}`);
console.log(`Channel: ${t.channel} | Status: ${t.status} | AI turns: ${t.ai_turn_count}`);
console.log(`Tags: ${(t.tags || []).join(", ")}`);
if (t.ai_detected_intent) console.log(`Detected intent: ${t.ai_detected_intent} (${(t.ai_intent_confidence * 100).toFixed(0)}%)`);
if (t.escalated_to) console.log(`Escalated to: ${t.escalated_to} (${t.escalation_reason})`);

const { data: msgs } = await admin
  .from("ticket_messages")
  .select("id, direction, visibility, author_type, body, body_clean, created_at, macro_id, pending_send_at, sent_at, send_cancelled")
  .eq("ticket_id", TID)
  .order("created_at", { ascending: true });

console.log(`\n--- Messages (${msgs?.length}) ---\n`);
for (const m of msgs || []) {
  const t = m.created_at?.slice(11, 19);
  const tag = `[${m.direction}/${m.author_type}${m.visibility === "internal" ? "/INTERNAL" : ""}]`;
  console.log(`${t} ${tag}`);
  const cancelled = m.send_cancelled ? " (CANCELLED)" : "";
  const pending = m.pending_send_at && !m.sent_at && !m.send_cancelled ? " (pending)" : "";
  const body = (m.body_clean || m.body || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  console.log(`  ${body.slice(0, 1200)}${body.length > 1200 ? "…" : ""}${cancelled}${pending}`);
  console.log();
}
