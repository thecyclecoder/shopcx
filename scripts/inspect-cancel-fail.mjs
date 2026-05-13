import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TICKET_ID = "41247615-e60d-4a56-add3-85189454b3c9";

const { data: ticket } = await admin
  .from("tickets")
  .select(
    "id, subject, status, channel, customer_email, handled_by, ai_turn_count, ai_escalation_reason, tags, journey_id, journey_step, agent_intervened, created_at, updated_at",
  )
  .eq("id", TICKET_ID)
  .maybeSingle();
console.log("Ticket:");
console.log(JSON.stringify(ticket, null, 2));

const { data: messages } = await admin
  .from("ticket_messages")
  .select("id, author_type, direction, visibility, body_clean, body, created_at")
  .eq("ticket_id", TICKET_ID)
  .order("created_at", { ascending: true });
console.log(`\n${messages?.length} messages:`);
for (const m of messages || []) {
  const body = (m.body_clean || m.body || "").replace(/\n+/g, " ").slice(0, 300);
  console.log(`  [${m.created_at}] ${m.author_type}/${m.direction}/${m.visibility}:`);
  console.log(`    ${body}`);
}

// Look for ai_analyses
const { data: analyses } = await admin
  .from("ticket_analyses")
  .select("model, analysis, decision, action_taken, created_at")
  .eq("ticket_id", TICKET_ID)
  .order("created_at", { ascending: false })
  .limit(5);
console.log(`\n${analyses?.length || 0} analyses:`);
for (const a of analyses || []) {
  console.log(`  [${a.created_at}] model=${a.model}`);
  console.log(`    action: ${a.action_taken}`);
  console.log(`    decision:`, JSON.stringify(a.decision, null, 2)?.slice(0, 1500));
}
