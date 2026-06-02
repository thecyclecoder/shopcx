import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Most recent nightly analysis notification
const { data: notifs } = await admin
  .from("dashboard_notifications")
  .select("id, title, body, metadata, created_at")
  .eq("workspace_id", W)
  .filter("metadata->>type", "eq", "ai_nightly_analysis")
  .order("created_at", { ascending: false })
  .limit(3);

for (const n of notifs || []) {
  console.log(`\n========== ${n.created_at} ==========`);
  console.log("Title:", n.title);
  console.log("Body:", n.body);
  const m = n.metadata || {};
  console.log("\nOverall score:", m.overall_score, "| Conversations:", m.conversations_analyzed);
  console.log("Channel scores:", m.channel_scores);
  console.log("\nIssues:");
  for (const issue of m.issues || []) {
    const tid = m.ticket_ids?.[issue.ticket_index - 1] || "?";
    console.log(`  [#${issue.ticket_index}] (${issue.type}) ${issue.description}`);
    console.log(`     ↳ ticket: ${tid}`);
  }
  console.log("\nAction items:");
  for (const a of m.action_items || []) {
    console.log(`  [${a.priority}] ${a.description}`);
  }
  if (m.summary) console.log("\nSummary:", m.summary);
}
