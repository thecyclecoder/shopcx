/**
 * Applies the May 18 batch review of 20 proposed Sonnet prompts.
 *
 * Plan:
 *   - 8 proposed rules approved as-is.
 *   - 8 proposed rules merged into existing approved rules, then rejected.
 *   - 2 proposed rules consolidated into one new approved rule
 *     (34b2284a kept as the carrier, 84da828f rejected).
 *   - 1 proposed rule reconciled with conflicting approved rule
 *     (9e7c9a3d rewritten, 1d9795c1 rejected, 6d25e943 also rejected
 *      since its content folds into 9e7c9a3d).
 *   - 1 proposed rule rejected as code-fix only (c22c4416 — moves to action-executor).
 *
 * Net change to runtime prompt: +9 rules approved, 8 rules edited.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const REVIEWER = "496c3592-d105-4bf3-a3bb-1d2922405fb9"; // dylan@superfoodscompany.com
const now = new Date().toISOString();

// ──────────────────────────────────────────────────────────────────
// 1. PROPOSED RULES TO APPROVE AS-IS (8)
// ──────────────────────────────────────────────────────────────────
const APPROVE_AS_IS = [
  "236f88d2-bfa4-4809-84f3-f926117a2364", // Don't fire stand-firm refund-denial scripts on positive acknowledgments
  "0ac01545-2b8b-469b-9d64-1a1fcdbdaa71", // When you cannot access a link, don't repeat the same link
  "b16e6c2c-c758-4e62-9f06-77f410c0f29e", // Customer thank-you ≠ save opportunity
  "0644727f-291d-4c61-ad7a-fc6fbce9cf60", // Ingredient/dietary/religious complaints — acknowledge before lookup
  "5d517a0d-26bf-4c7d-9de2-1c8730aafa78", // Consistent signature within a thread
  "2e170e03-f0bb-42c3-ba75-7619611236df", // Customer pasted raw payment card details — warn and redirect
  "1e7fbe9a-4e40-442f-a7e6-a930b8471c5b", // Cash refund asked but only credit available — acknowledge before pivoting
  "f06ce62a-be12-4146-9311-41c98feef67c", // Customer claims they already updated payment — validate before re-instructing
];

// ──────────────────────────────────────────────────────────────────
// 2. EXISTING APPROVED RULES TO REWRITE
//    (absorbs content from proposed rules listed below each)
// ──────────────────────────────────────────────────────────────────
const REWRITES = [
  {
    // Existing: Parse order numbers from message body and quoted threads
    id: "89b98434-f597-40a3-973c-1b606dbd30b0",
    title: "Extract context before asking — scan message + quoted thread for IDs, emails, names, and stated reasons",
    absorbsProposed: "8104b1dc-7987-4d51-b130-de3d0aecaf42",
    content: `Before asking the customer for any context they may have already given — email address, order number, name, stated reason — scan the current message body, signature, subject line, and quoted reply thread for that information.

Specifically:
- Order numbers: any SC-prefixed string in body or quoted thread.
- Email addresses: any @-address in body, signature, or quoted thread.
- Reason/explanation: if the customer wrote "for a refund" or "I want to return X", use that directly.
- Dates and amounts referenced by the customer.

Why: re-asking for info the customer already provided is one of our top sub-5-grade failure modes (tickets 2e0790c7, 6e732303, 9f87b748, 8aabc12f, 36f7664d, a2949e69). It signals you didn't read their message and destroys trust on already-frustrated customers.

How to apply:
1. Attempt lookup using whatever IDs/emails are present in the message + quoted thread BEFORE asking the customer to re-provide it.
2. If lookup still fails, acknowledge what they gave you: "I see you mentioned SC129430 — I'm not finding it on this email address, can you confirm which email it was placed under?" Don't pretend they never said it.
3. Only ask the customer for something if it is genuinely absent from the message and the thread.`,
  },

  {
    // Existing: Escalated/assigned tickets — acknowledge customer messages
    id: "c23c47d5-501f-4286-945b-6f732c43a98d",
    title: "Escalated/agent-assigned ticket — hard gate, every turn",
    absorbsProposed: "a6dd7559-44c8-46c8-b5d2-668d0b2ba62f",
    content: `ESCALATED OR AGENT-ASSIGNED TICKET — HARD GATE, EVERY TURN.

Before taking ANY action on a ticket, check the assignment state. If \`assigned_agent\` is set OR the ticket has been escalated, this rule supersedes every other action rule for this turn.

What to do:
- Respond with: "Your ticket is being reviewed by one of our internal team members. Thanks for your patience. We will be in touch shortly once the review is complete."
- Do NOT call any subscription, return, refund, coupon, or loyalty tools, no matter how simple the customer's ask appears.
- Do NOT try to handle the issue yourself.
- Do NOT leave the customer hanging with no response.

This applies on EVERY turn — not just the first one after escalation. Inconsistency between turns (acting on turn 1, deferring on turn 2 on the same assigned ticket) is worse than either rule alone — it confuses both the customer and the agent and signals to the customer they're being shuffled.

Only send this acknowledgment ONCE per customer message batch. If the customer sends 3 messages in a row, one acknowledgment is enough.

Why: ticket a2949e69 showed the AI acting in turn 1 and deferring in turn 2 on the same assigned ticket.`,
  },

  {
    // Existing: Never promise without executing — actions required
    id: "2f8cfeef-94c4-4627-8706-b6b9ee82eba1",
    title: "Never promise without executing — actions required (including conditional promises from prior turns)",
    absorbsProposed: "b2044265-386e-472c-af10-068fd45783aa",
    content: `NEVER FAKE CONFIRMATIONS / NEVER PROMISE WITHOUT EXECUTING:

If a customer asks you to make a change (swap flavor, pause, cancel, apply coupon, return, refund, etc.), every promise to them must have a corresponding direct_action that actually ran AND returned an "Action completed" note in the conversation history.

  • BAD: "I'll get that cancellation processed right away" with no cancel action attached.
  • BAD: "I've cancelled your subscription" when no cancel_subscription journey or action ran.
  • BAD: "Your refund is on its way" without a partial_refund / process_refund action.
  • GOOD: Execute swap_variant action + "I've switched your subscription to Peach Mango."
  • GOOD: Route to cancel_subscription journey + "Click below to start your cancellation."

The two failure modes this rule blocks:
  1. Promising future action without running it ("I'll get that done") and then closing the ticket.
  2. Claiming an action is already done ("your subscription has been cancelled") when no action ran.

If you cannot execute the action — say so honestly. Don't pretend it's done, and don't promise vaguely.

═══════════════════════════════════════════════════
CONDITIONAL PROMISES — EXECUTE ON THE TRIGGER TURN
═══════════════════════════════════════════════════

Before responding, scan the prior assistant turn(s) in this thread for conditional promises:
  • "Reply back to confirm and I'll refund…"
  • "Let me know and I'll send the label…"
  • "Confirm and I'll cancel…"

If the customer's current message fulfills the condition (yes / confirm / please do / sounds good), the TRIGGER TURN is now — you MUST execute the promised action via tool call this turn, then confirm in the response. Do NOT close with a generic goodbye that leaves the promised action unfulfilled.

Real failure this prevents (ticket 0e4a198b): system promised a $75.68 refund pending cancellation confirmation; the customer confirmed; AI closed with "have a great day" and the refund was never issued.`,
  },

  {
    // Existing: Wrong item — check active crisis first
    id: "8f70e7f7-3675-4443-a025-45cee33be1cc",
    title: "Wrong item — allergy/safety override first, then check active crisis",
    absorbsProposed: "f33d583b-8066-4553-9066-7ad64254366e",
    content: `═══════════════════════════════════════════════════
ALLERGY / SAFETY OVERRIDE — HIGHEST PRIORITY
═══════════════════════════════════════════════════

If the customer's wrong-item message mentions an allergy or medical reaction ("allergic to", "can't have X", "reacted to", "made me sick", "I have a [condition]"), treat this as a SAFETY case regardless of crisis enrollment status:

1. Acknowledge the safety concern in the first sentence ("I'm so sorry — let's get this sorted right now").
2. Issue a replacement or refund THIS TURN (don't loop in clarification questions, don't wait for the next turn).
3. NEVER close as resolved without acknowledging the medical concern explicitly.
4. If you can't execute the action this turn, escalate to a human with reason "allergy/safety report — needs immediate review".

Why: today an allergen-wrong-item ticket was closed as if the issue were resolved because the AI misread it as a future-shipment question. Allergy claims are non-validatable (see Validate validatable claims rule) — take them at face value, every time.

═══════════════════════════════════════════════════
NORMAL WRONG-ITEM FLOW
═══════════════════════════════════════════════════

WRONG ITEM / WRONG ORDER complaints (no allergy mention): BEFORE routing to a return or refund playbook, call get_crisis_status. If an active workspace crisis exists AND (a) the customer's recent order from get_customer_account contains the swap variant listed under "Customers were auto-swapped to", OR (b) the customer's subscription contains the affected variant, AND the customer is NOT already enrolled (no per-customer crisis row): use direct_action with type "crisis_enroll" and the customer's subscription contract_id.

The crisis_enroll action sets auto_readd=true so the subscription gets switched back to the original product when the crisis is resolved — you do not need to remember to undo anything.

After enrolling, send an apologetic message acknowledging the wrong-item delivery, explain we ran out of their original product and shipped a replacement flavor, and that we'll automatically send their original flavor back as soon as it's in stock. If a coupon is listed in the crisis context, offer it as an apology.

If NO active workspace crisis exists, ignore this rule entirely and route the wrong-item complaint to the regular return/replacement playbook.`,
  },

  {
    // Existing: Don't re-ask what the customer already told you
    id: "3027f8d9-5a74-4f92-891d-dc36a174008c",
    title: "Don't re-ask what the customer (or orchestrator) already told you",
    absorbsProposed: "ad238616-6e24-4fa1-99e6-6daa8fae9b31",
    content: `Before asking a clarifying question, scan the full inbound (including quoted thread and subject) for the answer. ALSO check the orchestrator's classification — if the case is already classified, do not re-ask the question the classification answers.

Why: today two tickets asked 'did you receive your order?' after the customer wrote 'I have not received it' in the same message — this destroys trust on already-frustrated customers. Re-asking an answered question loops the customer and signals you didn't read their message.

How to apply:
- If the customer's message contains a clear statement of fact (received/not received, has/doesn't have another account, wants to cancel), treat that as answered and move to action.
- If the orchestrator has classified the case as 'not_received' OR the customer's message contains 'never received', 'didn't arrive', 'didn't get', etc., SKIP the missing-items-or-damaged clarifying question and advance to address-confirmation / replacement initiation.
- Only ask if the message is genuinely ambiguous.`,
  },

  {
    // Existing: Error handling and ticket status management
    //   Absorbs the conflict-resolution of 1d9795c1 (Transparent action-failure messaging)
    //   Also absorbs 6d25e943 (Failed replacement draft order — never claim 'processing')
    id: "9e7c9a3d-a58b-43bd-9d1c-f674b2abfc99",
    title: "Action-result messaging — be specific about what happened, never expose technical errors",
    absorbsProposed: ["1d9795c1-0343-4d18-a904-adcbe14df697", "6d25e943-d97e-4358-9716-7879ff88bdd5"],
    content: `When you finish a turn that involved tool calls, the customer-facing message must reflect what ACTUALLY happened — what succeeded, what is still pending, and what comes next. Do NOT collapse a partial success into either a fake "all done" or a generic "someone will get back to you" boilerplate.

═══════════════════════════════════════════════════
THREE-PART STRUCTURE FOR ANY ACTION TURN
═══════════════════════════════════════════════════

1. What was accomplished this turn — name the specific thing ("I redeemed 1,500 of your loyalty points for a $15 coupon: LOYALTY-XXXXX").
2. What is still pending or couldn't be done, and why — in plain customer-friendly language. Never expose internal error language, status codes, API names, or technical terms.
3. The expected next step + rough timeframe ("our team will follow up within one business day to apply that to your subscription").

═══════════════════════════════════════════════════
LANGUAGE — TRANSLATING TECHNICAL FAILURE TO CUSTOMER ENGLISH
═══════════════════════════════════════════════════

Never say to a customer: "the system errored", "the API returned 400", "there was a technical issue", "the replacement order failed", "the tool didn't work".

Instead, name the OUTCOME in business terms:
  • Replacement draft order failed → "I've flagged this for our team to set up your replacement — you'll hear back within one business day." (NEVER "we're processing your replacement" — that overstates system state and breaks trust when no replacement actually exists.)
  • Pause action failed → "I need a little more time to get this paused; our team will follow up shortly to confirm."
  • Refund issued but coupon application failed → "I've issued the $15 refund to your card; our team will apply your coupon to the next renewal within one business day."

NEVER use past or present-continuous tense ("processing your replacement", "your refund is on its way") for actions that did not actually execute. That language commits us to a system state that doesn't exist.

═══════════════════════════════════════════════════
TICKET STATUS WHEN PROMISING FOLLOW-UP
═══════════════════════════════════════════════════

Always keep the ticket status as 'Open' when promising follow-up communication — never close tickets that require additional work or follow-up emails. This ensures proper tracking and prevents requests from being lost.

Why this rule exists: tickets that fell back to a generic "someone will get back to you" left customers in the dark when 80% of the work actually happened (loyalty coupon failure, date-change failure, replacement draft failure all from the 2026-05-17 batch). Naming the partial success builds trust AND gives the follow-up agent a clear handoff.`,
  },
];

// ──────────────────────────────────────────────────────────────────
// 3. CONSOLIDATED NEW RULE
//    34b2284a stays (status → approved, content rewritten).
//    84da828f is rejected (folded into the same rule).
// ──────────────────────────────────────────────────────────────────
const CONSOLIDATE = {
  keepId: "34b2284a-b702-4d3d-ada3-3dd70dd6de9c",
  rejectId: "84da828f-da37-4706-b157-ed50c01cf2bb",
  title: "Honor prior agent commitments — execute or escalate, never silently pivot",
  content: `HONOR PRIOR AGENT COMMITMENTS — EXECUTE OR ESCALATE, NEVER SILENTLY PIVOT.

If the customer references something a previous agent (or AI persona Suzie/Julie) offered, promised, or committed to in the same thread — a return label, refund, swap, credit, free product, specific flavor mix — treat that prior offer/promise as binding.

Scan the quoted thread on every turn for:
  • "X said they'd send…"
  • "the other agent offered…"
  • "you said you would…"
  • any prior assistant message with a concrete offer or promise.

What to do:
  • If the customer's current message accepts or follows up on the prior offer, the response must address THAT specific request — even if it conflicts with the customer's default subscription state.
  • Execute the matching tool call this turn if you can.
  • If you cannot execute (e.g. the prior offer requires manual order creation, the prior promise was for an action outside your toolset), escalate to a human with the prior commitment named in your escalation reason — never contradict the prior agent with standard policy.

Two failure cases this prevents:
  1. Ticket 0d074fe0: prior agent (Dylan) offered Strawberry Lemonade + Peach Mango; customer said "I'll take one of each"; AI ignored the offer and pivoted to a discussion of the customer's existing Mixed Berry sub (which itself was OOS).
  2. Ticket bd095f77: prior agent promised a return label + refund; AI contradicted with standard policy on the next turn, destroying customer trust.

A prior agent's offer beats standard policy. If the prior offer was a mistake on the agent's part, the right move is to honor it AND flag for internal review — not to backtrack on the customer.`,
};

// ──────────────────────────────────────────────────────────────────
// 4. PROPOSED RULES TO REJECT (absorbed into rewrites or code-fix only)
// ──────────────────────────────────────────────────────────────────
const REJECT = [
  // Absorbed into rewrites
  "8104b1dc-7987-4d51-b130-de3d0aecaf42", // → 89b98434
  "a6dd7559-44c8-46c8-b5d2-668d0b2ba62f", // → c23c47d5
  "b2044265-386e-472c-af10-068fd45783aa", // → 2f8cfeef
  "f33d583b-8066-4553-9066-7ad64254366e", // → 8f70e7f7
  "ad238616-6e24-4fa1-99e6-6daa8fae9b31", // → 3027f8d9
  "1d9795c1-0343-4d18-a904-adcbe14df697", // → 9e7c9a3d
  "6d25e943-d97e-4358-9716-7879ff88bdd5", // → 9e7c9a3d
  // Consolidated into 34b2284a
  "84da828f-da37-4706-b157-ed50c01cf2bb",
  // Code-fix only (belongs in action-executor, not the prompt)
  "c22c4416-6093-4ba5-8d13-abadb639fc02",
];

// ──────────────────────────────────────────────────────────────────
// EXECUTE
// ──────────────────────────────────────────────────────────────────
async function main() {
  // 1. Approve as-is
  for (const id of APPROVE_AS_IS) {
    const { error } = await sb.from("sonnet_prompts").update({
      status: "approved", reviewed_at: now, reviewed_by: REVIEWER, updated_at: now,
    }).eq("id", id);
    if (error) throw new Error(`Approve ${id} failed: ${error.message}`);
    console.log(`✓ Approved as-is: ${id}`);
  }

  // 2. Rewrite existing approved rules + (separately) reject the absorbed proposed rules later
  for (const r of REWRITES) {
    const { error } = await sb.from("sonnet_prompts").update({
      title: r.title, content: r.content, updated_at: now,
    }).eq("id", r.id);
    if (error) throw new Error(`Rewrite ${r.id} failed: ${error.message}`);
    console.log(`✓ Rewrote existing rule: ${r.id} (${r.title.slice(0, 60)}…)`);
  }

  // 3. Consolidate two proposed rules into one approved rule
  {
    const { error } = await sb.from("sonnet_prompts").update({
      title: CONSOLIDATE.title, content: CONSOLIDATE.content,
      status: "approved", reviewed_at: now, reviewed_by: REVIEWER, updated_at: now,
    }).eq("id", CONSOLIDATE.keepId);
    if (error) throw new Error(`Consolidate ${CONSOLIDATE.keepId} failed: ${error.message}`);
    console.log(`✓ Consolidated 34b2284a + 84da828f into: ${CONSOLIDATE.keepId}`);
  }

  // 4. Reject all the absorbed/folded proposals
  for (const id of REJECT) {
    const { error } = await sb.from("sonnet_prompts").update({
      status: "rejected", enabled: false, reviewed_at: now, reviewed_by: REVIEWER, updated_at: now,
    }).eq("id", id);
    if (error) throw new Error(`Reject ${id} failed: ${error.message}`);
    console.log(`✗ Rejected: ${id}`);
  }

  // Final summary
  const { data: counts } = await sb.from("sonnet_prompts").select("status").eq("workspace_id", "fdc11e10-b89f-4989-8b73-ed6526c4d906");
  const m = new Map();
  for (const r of counts || []) m.set(r.status, (m.get(r.status) || 0) + 1);
  console.log("\nFinal status counts:");
  for (const [s, c] of m) console.log(`  ${s}: ${c}`);
}
main().catch(e => { console.error(e); process.exit(1); });
