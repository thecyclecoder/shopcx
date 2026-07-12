/**
 * investigate-ticket — the ticket-investigation runnable (drives the `investigate-ticket` skill).
 *
 * Given a ticket id OR a dashboard link, prints the ticket's FULL picture in one read: header +
 * customer, merge/redirect history, chronological messages (with delivery state), Sol Direction
 * artifacts, Sol `ticket-handle` box-session jobs, and a turn-by-turn diagnosis that flags SILENT
 * turns (a customer wrote in, Sol ran, but nothing shipped). Merge-aware: a stale/merged-away id
 * resolves to the surviving ticket automatically.
 *
 * ALL reads go through the [[../src/lib/tickets-read]] SDK — never raw `.from("tickets")` queries
 * (CLAUDE.md discipline). Read-only; mutates nothing.
 *
 *   npx tsx scripts/investigate-ticket.ts <ticket-id | https://shopcx.ai/dashboard/tickets/{id}>
 *
 * See .claude/skills/investigate-ticket/SKILL.md.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { investigateTicket, buildTurnTimeline } from "../src/lib/tickets-read";

const strip = (s: string | null | undefined) =>
  String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const t = (iso: string | null | undefined) => (iso ? iso.slice(5, 19).replace("T", " ") : "—");
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

async function main() {
  const ref = process.argv[2];
  if (!ref) {
    console.error("usage: investigate-ticket <ticket-id | dashboard-link>");
    process.exit(1);
  }
  const admin = createAdminClient();
  const inv = await investigateTicket(admin, ref);

  if (!inv.ticket) {
    console.log(`No ticket found for ${inv.ref.requested}` + (inv.ref.redirected ? ` (resolved → ${inv.ref.resolved})` : ""));
    process.exit(0);
  }
  const tk = inv.ticket;

  // ── header ──
  console.log(`\n=== TICKET ${short(tk.id)} — "${strip(tk.subject).slice(0, 60)}" ===`);
  if (inv.ref.redirected) console.log(`  ↪ requested ${short(inv.ref.requested)} was merged/redirected → ${short(inv.ref.resolved)}`);
  console.log(`  status=${tk.status}  channel=${tk.channel}  created=${t(tk.created_at)}  closed=${t(tk.closed_at)}`);
  const cust = inv.customer;
  console.log(`  customer=${cust?.first_name || "?"} <${cust?.email || "—"}>  handled_by=${tk.handled_by || "—"}`);
  console.log(`  tags=${JSON.stringify(tk.tags || [])}`);
  console.log(`  active_playbook=${short(tk.active_playbook_id)} step=${tk.playbook_step ?? 0}` +
    (tk.escalated_to ? `  ESCALATED→${short(tk.escalated_to)} @${t(tk.escalated_at)} (${strip(tk.escalation_reason).slice(0, 50)})` : ""));
  console.log(`  Cora grading: last_analyzed_at=${tk.last_analyzed_at ? t(tk.last_analyzed_at) + " (GRADED)" : "never (UNGRADED)"}`);

  // ── merge history ──
  if (inv.mergedFrom.length) {
    console.log(`\n--- MERGED-IN TICKETS (${inv.mergedFrom.length}) ---`);
    for (const m of inv.mergedFrom) console.log(`  ${short(m.id)} "${strip(m.subject).slice(0, 40)}" [${m.status}] created=${t(m.created_at)}`);
  }

  // ── messages ──
  console.log(`\n--- MESSAGES (${inv.messages.length}) ---`);
  for (const m of inv.messages) {
    let sendState = "";
    if (m.author_type === "ai" && m.visibility === "external") {
      sendState = m.sent_at ? " ✅SENT" : m.send_cancelled ? " ✖CANCELLED" : m.pending_send_at ? ` ⏳STAGED@${t(m.pending_send_at)}` : " ⚠️UNSENT";
    }
    console.log(`  ${t(m.created_at)} [${m.visibility}/${m.author_type}/${m.direction || "-"}]${sendState} ${strip(m.body_clean || m.body).slice(0, 120)}`);
  }

  // ── directions ──
  console.log(`\n--- SOL DIRECTIONS (${inv.directions.length}) ---`);
  for (const d of inv.directions) {
    const plan = d.plan || {};
    const planKeys = Object.keys(plan);
    const hasSteps = Array.isArray((plan as { steps?: unknown }).steps);
    console.log(`  ${t(d.authored_at)} [${d.superseded_at ? "superseded" : "LIVE"}] path=${d.chosen_path} by=${d.authored_by} resession=${d.resession_count ?? 0}`);
    console.log(`      intent: ${strip(d.intent).slice(0, 90)}`);
    console.log(`      plan keys: [${planKeys.join(", ")}]${hasSteps ? "  ⚠️ plan.steps present (narrative — not executable actions)" : ""}`);
  }

  // ── handle jobs ──
  console.log(`\n--- SOL ticket-handle JOBS (${inv.handleJobs.length}) ---`);
  for (const j of inv.handleJobs) {
    console.log(`  [${j.status}] ${t(j.created_at)}→${t(j.updated_at)} terminal=${j.terminal_reason || "—"}` +
      (j.error ? `  ERR=${j.error.slice(0, 80)}` : ""));
    if (j.session_note) console.log(`      note: ${j.session_note.slice(0, 100)}`);
  }

  // ── turn-by-turn diagnosis ──
  const turns = buildTurnTimeline(inv);
  console.log(`\n--- TURN-BY-TURN DIAGNOSIS (${turns.length} customer turns) ---`);
  for (const turn of turns) {
    console.log(`  Turn ${turn.turn} @ ${t(turn.customerAt)}: "${turn.customerBody.slice(0, 80)}"`);
    console.log(`      direction=${turn.direction ? turn.direction.chosen_path : "NONE"}  reply-delivered=${turn.firstReplyDelivered ? "YES" : "NO"}  plan-has-action-steps=${turn.planHasActionSteps ? "YES" : "no"}`);
    if (turn.silentTurn) console.log(`      ⚠️  SILENT TURN — a Direction was authored but NO reply shipped (Sol ran, customer got nothing)`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("investigate-ticket failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
