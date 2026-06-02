import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data } = await admin.from("dashboard_notifications")
  .select("created_at, metadata")
  .eq("workspace_id", W)
  .filter("metadata->>type", "eq", "ai_nightly_analysis")
  .order("created_at", { ascending: false })
  .limit(1);

const latest = data?.[0];
if (!latest) { console.log("No analyses found"); process.exit(0); }

const m = latest.metadata;
console.log(`Date: ${latest.created_at}`);
console.log(`Score: ${m.overall_score}/10`);
console.log(`Conversations analyzed: ${m.conversations_analyzed || 0}`);
console.log(`\nSummary: ${m.summary || "(none)"}`);
console.log(`\nTicket IDs: ${(m.ticket_ids || []).join(", ")}`);

console.log(`\n──── ISSUES (${(m.issues || []).length}) ────`);
for (const i of m.issues || []) {
  const tid = m.ticket_ids?.[i.ticket_index - 1];
  console.log(`\n[#${i.ticket_index}] ${i.type}`);
  console.log(`  ${i.description}`);
  if (tid) console.log(`  → https://shopcx.ai/dashboard/tickets/${tid}`);
}

console.log(`\n──── ACTION ITEMS (${(m.action_items || []).length}) ────`);
for (const a of m.action_items || []) {
  console.log(`\n[${a.priority}] ${a.description}`);
}

if (m.channel_scores) {
  console.log(`\n──── CHANNEL SCORES ────`);
  for (const [ch, s] of Object.entries(m.channel_scores)) {
    console.log(`  ${ch}: ${s}/10`);
  }
}
