import { createAdminClient } from "./_bootstrap";
import { investigateTicket, buildTurnTimeline } from "../src/lib/tickets-read";

async function main() {
  const admin = createAdminClient();
  // Find open tickets
  const { data: open } = await admin
    .from("tickets")
    .select(
      "id, subject, status, channel, created_at, updated_at, last_customer_reply_at, last_analyzed_at, escalated_to, escalated_at, escalation_reason, assigned_to, handled_by, ai_handled, ai_handled_at, sol_handled_at, ai_disabled, analyzer_locked, do_not_reply",
    )
    .in("status", ["open", "escalated", "pending"])
    .order("updated_at", { ascending: false })
    .limit(50);

  console.log("=== OPEN-ish tickets ===");
  console.log(JSON.stringify(open, null, 2));

  if (!open) return;
  for (const t of open) {
    console.log("\n\n########################################");
    console.log(`### INVESTIGATE ${t.id}  (${t.status})  "${t.subject}"`);
    console.log("########################################");
    const inv = await investigateTicket(admin, t.id);
    console.log("customer:", JSON.stringify(inv.customer));
    console.log(`messages: ${inv.messages.length}, directions: ${inv.directions.length}, handleJobs: ${inv.handleJobs.length}, mergedFrom: ${inv.mergedFrom.length}`);
    console.log("--- messages ---");
    for (const m of inv.messages) {
      const body = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      console.log(
        `[${m.created_at}] dir=${m.direction} vis=${m.visibility} author=${m.author_type} ai_draft=${m.ai_draft} sent_at=${m.sent_at} pending=${m.pending_send_at} cancelled=${m.send_cancelled} email_status=${m.email_status}\n   ${body}`,
      );
    }
    console.log("--- directions ---");
    for (const d of inv.directions) {
      console.log(JSON.stringify({ intent: d.intent, chosen_path: d.chosen_path, context: d.context_summary, plan: d.plan, guardrails: d.guardrails, authored_at: d.authored_at, superseded_at: d.superseded_at, resession: d.resession_count }, null, 2));
    }
    console.log("--- handleJobs ---");
    for (const j of inv.handleJobs) {
      console.log(JSON.stringify({ kind: j.kind, status: j.status, error: j.error, session_note: j.session_note, preview_state: j.preview_state, terminal_reason: j.terminal_reason, created_at: j.created_at, updated_at: j.updated_at }, null, 2));
    }
    console.log("--- turn timeline ---");
    console.log(JSON.stringify(buildTurnTimeline(inv), null, 2));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
