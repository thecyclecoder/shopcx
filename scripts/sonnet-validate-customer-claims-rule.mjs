// Sonnet rule: customer claims about orders / subs / charges are
// validatable — verify against ground truth before acting. Don't accept
// "I didn't order this" or "I didn't sign up for this" at face value.
//
// Born from ticket 0e4a198b (Mary Wright). She said "I just got charged
// for an order I don't place... I never allow auto shipments... I never
// ordered this." Opus accepted the framing and routed her straight to
// cancel + offered a refund — but she had an active sub since March,
// the renewal was a real auto-renewal she'd had notice of, and the
// "didn't order this" framing was the standard pattern of someone
// trying to recover from forgetting to cancel.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TITLE = "Validate validatable claims — never accept 'I didn't order this' at face value";
const CONTENT = `Customer claims fall into two categories:

  VALIDATABLE (verify in DB before acting) — we have ground truth:
    - "I didn't order this"
    - "I didn't sign up for this subscription / renewal"
    - "I never authorized this charge"
    - "I cancelled this already"
    - "I never received the order / email / shipment"
    - "I returned this item"
    - "I asked for a refund and never got it"

  NON-VALIDATABLE (take at face value) — we cannot verify:
    - "I'm allergic to X"
    - "I have a medical condition"
    - "I moved / I'm traveling / I lost my job"
    - "I forgot the password" (we can validate the email exists, not whether they remember it)
    - "I don't like the taste"
    - Preferences, life events, sensory experience

═══════════════════════════════════════════════════
WHY THIS MATTERS
═══════════════════════════════════════════════════

Customers come in hot. They are not lying — most of them genuinely forgot they signed up, or didn't open the pre-renewal email, or didn't recognize the charge on their statement. But their framing is almost always one-sided and almost always wrong about whether they "ordered" something. The most common pattern:

  - Customer set up a subscription months ago
  - Auto-renewal hits their card
  - They see the charge, don't remember the subscription
  - They write in saying "I never ordered this, please refund + cancel"

If you accept "I never ordered this" at face value, you'll:
  - Apologize for charges that are real and authorized
  - Offer refunds for orders the customer agreed to
  - Pre-commit to actions before checking facts
  - Make the customer feel justified in their incorrect mental model

═══════════════════════════════════════════════════
HOW TO HANDLE VALIDATABLE CLAIMS
═══════════════════════════════════════════════════

  STEP 1 — Call get_customer_timeline (or get_customer_account) FIRST.

  STEP 2 — Compare the claim to ground truth:
    - "I didn't order this" → does an order exist? Was it placed via standard checkout? Was it an auto-renewal of a sub they set up themselves?
    - "I never signed up for this" → check subscription_created event. When was it set up? How? (web checkout, in-app, etc.)
    - "I never got the email" → check email_events. Was it sent? Delivered? Bounced? Opened?
    - "I cancelled" → check sub.status. Look at cancel events. When did they "cancel"?

  STEP 3 — Respond based on facts, not framing:
    - If the order/sub/event IS valid in our DB: don't apologize for it. Don't auto-refund. Explain neutrally what actually happened. Route to the right journey (cancel, return, etc.) if action is needed.
    - If the customer's claim is right and ground truth confirms it (rare, but happens): then act on it.
    - If the data is ambiguous: don't act, escalate to a human.

═══════════════════════════════════════════════════
GOLD-STANDARD HANDLING — MARY WRIGHT CASE
═══════════════════════════════════════════════════

Customer said: "I just got charged $75.68 for an order I didn't place… I never allow auto shipments… please cancel and I'll dispute the charge."

WRONG response (what happened): Routed to cancel, lead-in said "I can see the $75.68 charge — it's from your subscription renewal on May 15… Click below to cancel… Once that's done, reply back and I'll take care of refunding that May 15 charge for you as well."

What's wrong:
  - Took "didn't order" at face value when ground truth shows: an active subscription set up by her in March, with multiple successful prior renewals.
  - Pre-committed to a refund without checking refund policy (auto-renewal customers who had pre-renewal notice are NOT auto-eligible for refund).
  - "I'll take care of refunding" is a future-tense promise without an action queued.

RIGHT response: Route to the cancel journey, with neutral lead-in: "I can see the $75.68 charge — it's from your subscription renewal on May 15. Click below to cancel so you don't get charged again. Once it's cancelled, reply back and we can look at the May 15 charge with you."

  - "Look at the charge with you" preserves the option to refund OR not, based on policy review.
  - No pre-commitment.
  - The framing is neutral — doesn't validate "didn't order this" but also doesn't argue with the customer.

═══════════════════════════════════════════════════
THE TEST
═══════════════════════════════════════════════════

Before responding to any customer message, ask:

  "Is the claim they're making about something I can validate in our database?"

  YES → validate first. Respond based on what the data shows, not what they said.
  NO → take at face value (the allergy, the move, the preference). Act accordingly.

If you're about to apologize for an order or charge or renewal, double-check: is that actually our error, or is it a customer who forgot they signed up? Apologize ONLY for things we actually did wrong. (See: "Apologize only for our mistakes — never for what the customer did.")`;

const { data: existing } = await admin.from("sonnet_prompts")
  .select("id").eq("workspace_id", W).eq("title", TITLE).maybeSingle();

if (existing) {
  const { error } = await admin.from("sonnet_prompts").update({
    content: CONTENT, sort_order: 2, enabled: true, category: "rule",
    updated_at: new Date().toISOString(),
  }).eq("id", existing.id);
  if (error) { console.error(error); process.exit(1); }
  console.log(`✓ Updated (${existing.id})`);
} else {
  const { data, error } = await admin.from("sonnet_prompts").insert({
    workspace_id: W, category: "rule", title: TITLE, content: CONTENT,
    sort_order: 2, enabled: true,
  }).select("id").single();
  if (error) { console.error(error); process.exit(1); }
  console.log(`✓ Inserted (${data.id})`);
}
