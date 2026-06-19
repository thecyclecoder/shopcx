/**
 * Improve the refund playbook's opening tone (Dylan, 2026-06-19, ticket
 * cc3d6b9b). The first AI message read as a cold, date-by-date account ledger
 * ("January 1… May 21… June 19") with no acknowledgment of the customer's
 * stated hardship (wife hospitalized 13 days). The neutrality instruction on
 * the apply_policy step produced that robotic tone.
 *
 * Fix: step 0 (identify_order) + step 3 (apply_policy) now lead with a brief,
 * genuine acknowledgment when a hardship/distress signal is present, and
 * step 3 explains in plain human language instead of a mechanical timeline —
 * without apologizing for non-errors. (Hardship adjusts TONE only; the offer
 * ladder is unchanged — see operational-rules § Returns / hardship.)
 *
 * Dry-run by default. Pass --apply to update.
 */
import { createAdminClient } from "./_bootstrap";

const STEP0 = "170594aa-1cd9-4483-819f-c215ef752412"; // identify_order
const STEP3 = "3dd438c9-c8d1-407d-8eed-13a6b0361085"; // apply_policy
const APPLY = process.argv.includes("--apply");

const STEP0_INSTRUCTIONS = `Find their recent orders. If only one, confirm it. If multiple, list them and ask which one(s). If they say "all of them," resolve to array. If they say "most recent" or "last order," use the most recent one. Do not over-apologize — acknowledge the issue briefly and focus on identifying the order. IF the customer's opening carries a hardship or distress signal (medical emergency, hospitalization, bereavement, job loss, financial strain), lead with ONE brief, genuine line of empathy for that human situation before anything about the account (e.g. "I'm so sorry to hear your wife has been in the hospital — I hope she's doing okay."). Keep it to simple human acknowledgment ONLY — do NOT say "we'll make it right," "let me take care of this for you," or otherwise promise/hint at a fix, refund, exception, or any outcome; the empathy is warmth, not a commitment. Then move into identifying the order factually.`;

const STEP3_INSTRUCTIONS = `Explain what happened with their subscription and order based on the data. For EACH order, explain specifically why it does or does not qualify for return — mention the exact reason (e.g. "this was a recurring subscription order which does not qualify" or "this order is outside the 30-day return window"). Be neutral — say "here is what happened" not "you signed up." Only apologize if we have concrete evidence of an actual error on our part. Do not accept the customer's claims of wrongdoing without verification. If they have other active subscriptions, mention them proactively. Do NOT hint at exceptions, escalations, or future options. Just state the policy facts.

TONE: neutral does NOT mean cold or robotic. When the customer has shared a hardship (illness, hospitalization, financial strain, bereavement), open with ONE warm, genuine line of empathy before the explanation (e.g. "I'm so sorry to hear about your wife — I hope she's doing okay."). Keep that line to simple human acknowledgment ONLY — do NOT say "we'll make it right," "let me take care of this," or otherwise imply or promise a refund, exception, or positive outcome; the policy is decided on its facts, not promised up front. Then summarize what happened in plain, human language — do NOT deliver a mechanical date-by-date account ledger (e.g. listing "January 1… May 21… June 19"). Keep it concise and considerate. Acknowledging their situation is not apologizing for a company error or accepting fault — stay factual on the policy itself.`;

async function main() {
  const admin = createAdminClient();
  console.log(`=== Refund playbook tone update — ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  for (const [id, name, txt] of [[STEP0, "identify_order", STEP0_INSTRUCTIONS], [STEP3, "apply_policy", STEP3_INSTRUCTIONS]] as const) {
    const { data: before } = await admin.from("playbook_steps").select("instructions").eq("id", id).single();
    console.log(`\n--- step ${name} (${id}) ---`);
    console.log("BEFORE:\n" + before?.instructions);
    console.log("\nAFTER:\n" + txt);
    if (APPLY) {
      const { error } = await admin.from("playbook_steps")
        .update({ instructions: txt }).eq("id", id);
      if (error) throw new Error(`update ${name} failed: ${error.message}`);
      console.log("  ✓ updated");
    }
  }
  if (!APPLY) console.log("\n--- DRY RUN --- re-run with --apply.");
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
