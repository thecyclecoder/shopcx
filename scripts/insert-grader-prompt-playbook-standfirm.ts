/**
 * Insert an APPROVED grader_prompts calibration rule so the ticket analyzer
 * recognizes the refund playbook's designed stand-firm-then-save arc as
 * near-flawless execution — not an "inaccuracy" hard-cap + force-escalate.
 *
 * Approved by Dylan (2026-06-19), derived from ticket cc3d6b9b / analysis
 * aa6a00f1. The grader loads grader_prompts where status='approved' ordered by
 * sort_order (buildGraderSystemPrompt in ticket-analyzer.ts) — only `content`
 * + `title` render; there is no `enabled` column.
 *
 * Idempotent: skips if a rule with this title already exists.
 * Dry-run by default. Pass --apply to insert.
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "cc3d6b9b-7700-4e14-8a74-bb2833c9b718";
const ANALYSIS = "aa6a00f1-f093-4c48-9cf9-108b6f1f416d";
const APPLY = process.argv.includes("--apply");

const TITLE = "Refund-playbook stand-firm-then-save is correct execution, not an inaccuracy";

// NOTE: this is the FINAL content as live in grader_prompts (900a4fa0) after
// in-session tuning + validation re-grades against ticket cc3d6b9b (5 → 8, no
// escalation). The insert is idempotent-skip, so this constant is the audit
// record of the approved rule, not a re-applied write.
const CONTENT = `The refund playbook is DESIGNED to stand firm once before offering an exception, and a single pre-exception stand-firm round is correct EVEN for hardship customers. The "skip stand-firm on hardship" rule skips the MULTIPLE intermediate stand-firm rounds (the tiers between the first denial and escalation) — it does NOT mean the playbook never states the policy before offering the exception. So one stand-firm denial (e.g. "the 30-Day Money-Back Guarantee applies to first orders, not subscription renewals") followed by a Tier 1 store-credit or Tier 2 cash exception is the playbook working exactly as designed.

Do NOT label that stand-firm message "inaccuracy", "rule_violation", or a false denial, and do NOT apply any hard cap to it. Even when a system/orchestrator note in the thread says "skip stand-firm per hardship rule," a single pre-exception stand-firm round is STILL correct and is NOT a contradiction — that note refers to skipping the multiple intermediate stand-firm tiers, not the one policy statement before the exception. Do NOT flag the stand-firm round as "unnecessary," as drift, or as contradicting the hardship-skip instruction.

The IDEAL outcome of the refund playbook is: stand firm → customer pushes back (often with frustration or a threat to leave a negative review) → AI offers the exception → customer accepts → positive close. When the conversation shows this full arc ending in a save (store credit / refund) and a positive close, score it 9-10. This is near-flawless execution — the save-after-pushback is the GOAL, not a recovery from a failure. The customer's transient frustration or review threat that the save resolves is expected negotiation dynamics; it is never an AI failure and never an escalation trigger.

Tone/empathy phrasing may be noted as a MINOR issue (e.g. an opening that recaps account history before acknowledging a stated hardship), but on this arc it must NOT trigger a hard cap, must NOT trigger escalation, and must NOT pull the score below 8 on its own. The save + positive close dominates the grade.

This does NOT excuse genuine errors: a fabricated coupon code, wrong date, wrong price, an exception denied to a qualifying customer that is NEVER offered, or a stand-firm that never advances to the exception. The signal that it IS the designed pattern: a refund playbook is active on the ticket (pb:refund tag, "[Playbook]" / "stand firm N/2" system notes) AND the stand-firm denial is followed by the exception offer in a later turn.

Why: ticket cc3d6b9b (2026-06-19) — hardship customer, the refund playbook stood firm on a renewal order, the customer threatened reviews, the AI then offered Tier 1 store credit on the most recent in-window order, the customer accepted, positive close. It could not have gone better — yet the grader scored it 5 (inaccuracy hard-cap + force-escalate). This rule corrects that mis-grade.`;

async function main() {
  const admin = createAdminClient();
  console.log(`=== Insert grader calibration rule — ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  console.log("Title:", TITLE);
  console.log("\nContent:\n" + CONTENT + "\n");

  const { data: existing } = await admin.from("grader_prompts")
    .select("id, status").eq("workspace_id", WS).eq("title", TITLE).maybeSingle();
  if (existing) {
    console.log(`Rule already exists (${existing.id}, status=${existing.status}) — skipping (idempotent).`);
    return;
  }

  if (!APPLY) {
    console.log("--- DRY RUN --- would insert status=approved, sort_order=105. Re-run with --apply.");
    return;
  }

  const nowIso = new Date().toISOString();
  const { data: ins, error } = await admin.from("grader_prompts").insert({
    workspace_id: WS,
    title: TITLE,
    content: CONTENT,
    status: "approved",
    sort_order: 105,
    derived_from_ticket_id: TICKET,
    derived_from_analysis_id: ANALYSIS,
    proposed_at: nowIso,
    reviewed_at: nowIso,
  }).select("id, title, status, sort_order").single();
  if (error) throw new Error(`insert failed: ${error.message}`);
  console.log("  ✓ inserted:", JSON.stringify(ins));
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
