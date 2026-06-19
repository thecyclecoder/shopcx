/**
 * Insert an APPROVED sonnet_prompts rule: one return per ticket, most-recent
 * order only, no goodwill on the rest. Approved by Dylan (2026-06-19),
 * derived from ticket 1b62b00f (Traci Studebaker — AI created 3 returns).
 *
 * The code guard in create_return (action-executor.ts) is the hard backstop;
 * this rule stops the orchestrator from even TRYING to fan out returns or
 * promising multiple labels in its message. Loader: enabled=true +
 * status='approved' (sonnet-orchestrator-v2.ts). Only `content` renders.
 *
 * Idempotent: skips if a rule with this title already exists.
 * Dry-run by default. Pass --apply to insert.
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "1b62b00f-a1e3-45c0-b171-6667abd9b417";
const APPLY = process.argv.includes("--apply");

const TITLE = "One return per ticket — most recent eligible order only, no goodwill on the rest";

const CONTENT = `ONE RETURN PER TICKET — MOST RECENT ORDER ONLY.

We never issue more than ONE return per ticket, ever. Before emitting create_return, scan ACTIONS ALREADY COMPLETED on this ticket and get_returns output: if ANY non-cancelled return already exists for this customer, do NOT call create_return again — even if the customer is upset, even if they have several unwanted orders, even if they explicitly ask for more.

When a customer reports MULTIPLE unwanted orders (e.g. several auto-swapped shipments that stacked up while they were away), do NOT create a return for each and do NOT fan out multiple labels. Offer a single return for the MOST RECENT eligible order only. Do NOT goodwill-refund or goodwill-return the older orders — older shipments are typically past the 30-day window, and sympathy/hardship does not unlock extra returns, goodwill refunds, or a waived window (the same no-policy-drift principle as the refund playbook).

Honest framing in the message: "I'm so sorry this happened. The best we can do is set up a return for your most recent order (<order #>) — once it's back with us, we'll refund that order." Do not promise refunds or labels for the other orders.

Returning more than the most recent order, or a second return on a ticket/subscription that already has one, is a manual human decision. Set action_type to escalate with a holding message that does NOT promise additional labels: "Let me get a teammate to look at this directly so we can sort it out."

Why: the orchestrator once read "one label per order" and created THREE returns in a single turn (3 EasyPost labels + 3x refund exposure) for a hospitalized customer with 3 unwanted shipments (ticket 1b62b00f). Returns cost label fees + lost product; we never multiply that for one retention scenario.`;

async function main() {
  const admin = createAdminClient();
  console.log(`=== Insert prompt rule — ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  console.log("Title:", TITLE);
  console.log("\nContent:\n" + CONTENT + "\n");

  const { data: existing } = await admin.from("sonnet_prompts")
    .select("id, enabled, status").eq("workspace_id", WS).eq("title", TITLE).maybeSingle();
  if (existing) {
    console.log(`Rule already exists (${existing.id}, enabled=${existing.enabled}, status=${existing.status}) — skipping insert (idempotent).`);
    return;
  }

  if (!APPLY) {
    console.log("--- DRY RUN --- would insert as category=rule, enabled=true, status=approved, sort_order=5. Re-run with --apply.");
    return;
  }

  const nowIso = new Date().toISOString();
  const { data: ins, error } = await admin.from("sonnet_prompts").insert({
    workspace_id: WS,
    category: "rule",
    title: TITLE,
    content: CONTENT,
    enabled: true,
    status: "approved",
    sort_order: 5,
    derived_from_ticket_id: TICKET,
    proposed_at: nowIso,
    reviewed_at: nowIso,
    auto_decision_reason: "Approved by Dylan (founder) — verbal approval 2026-06-19, derived from ticket 1b62b00f.",
  }).select("id, title, enabled, status, sort_order").single();
  if (error) throw new Error(`insert failed: ${error.message}`);
  console.log("  ✓ inserted:", JSON.stringify(ins));
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
