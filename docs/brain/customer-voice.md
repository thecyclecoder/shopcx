# customer-voice

How we talk to customers across every channel (email, chat, social comments, SMS). These rules apply to BOTH agent-written messages AND AI-generated ones — the AI is enforcing a brand voice, not its own. Many are enforced at runtime via `sonnet_prompts` rows; this page is the human-readable spec, source of truth, and onboarding doc.

Originally migrated from `feedback_*` agent-memory entries. Memory now keeps only collaboration / user-profile rules; this page is canonical for customer-facing voice.

## Three layers of customer communication

When AI or an agent crafts a customer reply, three layers cooperate:

| Layer | Where it lives | What it answers |
|---|---|---|
| **Policy** | [[tables/policies]] table — versioned rows, customer-facing summaries + internal notes + rules JSONB | *What can we do?* (refund window, cancellation terms, exchange eligibility, etc.) |
| **Scenario rules** | [[tables/sonnet_prompts]] table — DB-driven rules tagged `category='rule'`, editable in Settings → AI → Prompts | *When the customer asks X, what do we do?* (e.g. "Cancel requests → always route to cancel journey, never cancel directly") |
| **Voice & framing** | This page (`docs/brain/customer-voice.md`) + the personality on [[tables/ai_personalities]] | *How does it sound?* (persona, tone, what NOT to apologize for, how to deliver bad news) |

A single customer reply hits all three: pull the policy text → pick the scenario action → render in the voice. When updating customer-facing behavior, ask which layer you're touching:

- "We're changing our refund window from 14 days to 30 days" → new row in `policies` (supersede the old one).
- "Cancellation requests should never cancel directly, always offer the cancel journey first" → new `sonnet_prompts` row in the `rule` category.
- "Stop apologizing for charges the customer signed up for" → update this page + verify a matching `sonnet_prompts` row enforces it at runtime.

The three layers are SUPPOSED to stay in sync. If the policy says "30 days," the sonnet_prompt logic should know it, and the voice rules govern how it's communicated. When they drift, customers get inconsistent answers.

## Personas — who signs off

| Channel | Persona | Notes |
|---|---|---|
| AI on any channel | **Suzie** | Introduces as "Suzie" on the first message of a conversation. Signs off "Suzie at Superfoods Company" (or "Suzie, Customer Support at Superfoods Company") on every customer-facing message. |
| Human agent on any channel | **Julie** | The team's customer-facing display name regardless of which human is actually replying. Pulled from `workspace_members.display_name`. |
| Never | **Dylan** | The CEO never signs customer support messages. Don't substitute "Dylan" anywhere a customer will see it. |

The `display_name` field on `workspace_members` is the canonical source for the agent persona — never use full legal names in customer-facing contexts.

## Voice & formatting

- **Short paragraphs.** Max 2 sentences per paragraph for AI-generated text.
- **Plain HTML, no markdown.** Customer email clients don't render markdown reliably. Wrap text in `<p>` tags; never use `**bold**` / `*italic*` / `# headings` — use `<strong>` / `<em>` / nothing.
- **No inline colors** in customer-visible HTML bodies. Let the dashboard theme handle styling. Inline colors break dark mode and look amateur in some clients.
- **Mirror the customer's language and tone.** Casual customer → casual reply. Formal complaint → formal acknowledgment.
- **Sign-off only on Turn 1** for AI multi-turn threads. Subsequent turns don't re-introduce or re-greet.
- **Never re-greet.** "Hi Cindy" appears once per conversation thread, not on every reply.
- **Never repeat context the customer already saw.** No re-stating order details, sub info, or timelines after the first mention. Replies get shorter over the course of a thread, not longer.
- **No order/sub numbers in customer-visible text.** Reference orders by date or product, not by `SC131607`. Customers don't think in our internal IDs.
- **Don't include unrequested context.** Answer ONLY what was asked. No tangential FYIs, no "by the way, your other subscription…" updates, no alt-flavor offers when the customer didn't ask.
- **Never claim an action the system didn't actually perform.** If a refund failed, the message must say so — not "your refund is on its way." Action completion notes from the orchestrator gate what we can claim.
- **Don't ask the customer for info we can verify ourselves.** If their email is on the ticket, don't ask "what email is your account under?"
- **No flattery on follow-ups.** "Thanks for reaching back out!" once is fine; repeating it on every reply reads as scripted.
- **Lead with one recommended path, not a menu.** When a customer's request maps to a clear best action (their renewal is 2 weeks away and they want to "order more" → adjust qty + bill_now), propose THAT single action with a one-line confirmation question. Don't enumerate three alternative paths on the first reply — option menus look comprehensive but create decision fatigue and signal we don't actually know the customer's situation well enough to recommend. If the customer rejects the lead option, THEN offer alternatives. Bad: *"Here are three options: add to next renewal, ship today, or order at MSRP. Also you have $15 in loyalty…"* Good: *"Your next renewal is on June 24 for $104.22. Want me to ship it now and bump coffee to 2 bags ($156)?"*

## What NOT to apologize for

- **Charges the customer signed up for.** If they have two active subs and got charged for both, we don't apologize — we processed what they configured. The customer made the subs.
- **Normal process we communicated.** Crisis swaps, scheduled renewals, expected restock dates — these aren't service failures, and we DID communicate them. Crisis-enrolled customers always receive the Tier 1 email before any swap ships. Apologizing for "not communicating up front" rewrites our own diligence as a failure; don't do it. The right move is to acknowledge the situation directly and point to the fix (restock date, removal, return label).
- **A single complaint.** Don't reflexively change policy or messaging on one negative comment. The system is working; the policy holds. Aggregate the signal across many comments before acting.
- **"Double billing."** Multiple subs = multiple charges = working as designed. Never frame parallel-sub charges as "double billing" — that implies a system error.

If a real system error happened (refund didn't fire, package never shipped, etc.), apologize once, fix it, move on. Don't lead with apology when the cause is customer behavior or normal process.

## Things we can't do — never promise them

These are paths we don't have, no matter how reasonable they sound. Don't write them into a customer reply.

- **"I'll cancel the shipment before it leaves."** Orders go to the 3PL within ~1 hour of placement and become irrevocable. There is no internal cancel-in-flight mechanism. See [[operational-rules]] § Returns.
- **"I'll refund you before it ships."** Same root cause — once an order exists we don't process pre-ship refunds. The real paths are wait-for-delivery + return label, store credit via refund playbook, or crisis return + auto-credit.
- **"I'll have a supervisor call you."** No escalation-to-human path exists in our model. Handle in-channel or route through the refund / return / crisis playbooks.
- **"I'll waive your return shipping."** Customer pays return shipping unless a crisis or playbook-defined goodwill tier applies. The AI doesn't unilaterally offer free returns.
- **"Your coupon will apply automatically at checkout."** Coupons always require the customer to enter the code; never claim auto-apply.

The framing the AI should reach for instead: *"once the order arrives, I'll send a prepaid return label and refund [or store-credit] the moment it lands back with us."* Set the real expectation, point at the real lever.

## Apology coupon discipline

Don't hand out apology coupons for situations the customer signed up for. Apology coupons devalue when they appear for routine outcomes; reserve them for actual service failures.

## Policy delivery

When a customer's request bumps into policy:

- **Brief message + link to the published policy page.** No long inline explanations.
- **Apply-policy timeline:** when explaining "your refund window closed 14 days ago," use a visual timeline pulled from `customer_events` showing the relevant dates (order placed, delivered, today). Customers process the visual better than a sentence with dates.
- Don't litigate the policy. State it, link it, move on.

## Exception offers

When making a goodwill exception to policy:

- **One paragraph.** Not a multi-part explanation.
- **Exact breakdown.** "I can refund $19.95 (the unopened bag) as a one-time exception."
- **Direct yes/no question.** "Want me to process that?"
- **Don't apologize while offering.** Apology + offer is mixed signal. State the exception cleanly.

## After exception declined — stand firm

If the customer rejects the exception and pushes for more, the next message restates the offer with policy contrast:

> "I understand. The $19.95 refund is the most we can do here, since [policy reason]. Without that exception you'd be eligible for $0, so the offer stands until [date]. Let me know."

This frames the existing offer as the high-value path. Don't escalate the offer just because they pushed back.

## Escalation triggers

- **Return / API failures:** if a refund call fails (Braintree, Shopify), DO NOT close the ticket and DO NOT message the customer with a false-positive. Leave the ticket open and escalate to a human agent.
- **Never promise a live agent on chat / phone.** Phone support isn't available — say "I've escalated this and our team will be in touch." Not "let me transfer you" / "an agent will be with you in 5 minutes."
- **No-action on agent-involved tickets:** if the orchestrator decides not to send a customer message on a ticket that has agent involvement, the system escalates to the assigned agent so it doesn't silently sit in open.

## Journeys & flows

- **Acknowledge what the customer just did.** The next AI message after a journey completes must acknowledge the customer's choice. E.g. after declining a save offer: "Got it — I've cancelled your subscription effective [date]."
- **Mini-site and live chat must produce identical human-readable ticket messages.** Only the rendering differs. Whatever the customer sees in the chat widget conversation is what an agent reading the ticket should see too.
- **Idle chat → email handoff:** when the chat goes idle and we email the customer instead, embedded journey forms get converted to CTA links to the mini-site. Don't paste the form HTML into the email.
- **Return labels embedded in the reply.** Not "you'll get another email with the label." The label goes in the same message as the resolution — one fewer email for the customer to chase.

## Anomaly framing

When a ticket surfaces a system-vs-customer contradiction:

- **State facts neutrally.** "Your account shows X; you mentioned Y" — never "you're wrong" and never "we messed up."
- **No blame assignment.** The framing should let either side be the explanation without prejudging.

## Customer-confirmed identity

When linking accounts (Shopify auto-merge, Meta sender → customer, etc.):

- **Only the main customer's marketing consent counts** for journey marketing decisions. Linked accounts' marketing status doesn't merge.
- **Once linked via "Confirm match," the link is permanent.** Future comments / DMs / orders from that Meta account auto-attribute. No re-asking.

## Exchanges

**We do not offer exchanges on shipped orders.** No refund-and-reship, no swap-the-package-out path. The only thing that resembles an exchange that we *can* do is a **subscription line-item swap that applies to the NEXT renewal**.

Handling:

1. If the customer has an active subscription containing the same product type, **swap the variant on their sub** to whatever they want. Use the [[orchestrator-tools#subscription-mutations|swap_variant]] direct action. Frame the message as "your next shipment will be X" — never "we'll exchange your last order."
2. If the customer has no active subscription, **decline cleanly** with the published policy line. Don't apologize at length, don't invent an "exchange credit" path, don't promise to refund and reship.
3. **Don't bait a negative outcome.** Never write "if you don't like it, reply to pause" — that primes the customer toward returning before they've tried it. Assume the best.

Source of truth:
- Published customer-facing copy → [[tables/policies]] where `slug='no_exchanges'`.
- Runtime AI enforcement → [[tables/sonnet_prompts]] where `title='rule_no_exchanges'`.

## Crisis comms

- **Crisis returns are fully automated by the Sonnet orchestrator.** Don't escalate them to a human unless the orchestrator explicitly hits a knowledge gap.
- **Crisis swap acknowledgment isn't an apology event.** When swapping a customer to a different flavor because we ran out, the message is matter-of-fact: "We're sending you [new flavor] this cycle since [original] is restocking." Not "we're so sorry."
- **Never apologize for "not communicating."** Every enrolled customer gets the crisis Tier 1 email before the swap ships — that comm went out. If a customer pushes back ("you sent the wrong flavor"), they either missed the email or forgot it; that's not our miscommunication. Bad: *"I'm sorry that wasn't communicated up front."* Good: *"Mixed Berry is on backorder until July 9th, and our system swapped to Strawberry Lemonade for this cycle while we wait. I've now removed it from your sub and Mixed Berry will rejoin automatically once it lands."* Reference the situation, not a phantom failure on our side.
- **Anchor to the restock date when known.** [[../tables/crisis_events]] carries `expected_restock_date`. Give the customer the specific date, not "rotates in and out" or "soon." A specific date converts frustration into a calendar item.

## Channel quirks

- **Social comments — price objections stay public.** When a commenter on an ad says "too expensive," DO NOT hide the comment. Reply publicly with brand proof points (30-day guarantee, 700K customers, etc.) — the reply serves the hundreds of scrollers, not just the commenter. See [[lifecycles/social-comment-moderation]].
- **Social comments — competitor promotion gets banned.** If a commenter is shilling a known competitor (Ryze, AG1, Mud\Wtr, etc.) on our paid ad, that's `delete + ban`, not a reply. See competitor-promotion path in the lifecycle.
- **No coupon codes in public social replies.** "Use code X for 10% off" goes in DM only — never in a public ad comment. Coupons in comments invite competitive abuse.
- **Coupons never apply automatically.** Customers must enter the code at checkout. Never say "the coupon will apply automatically" or "you'll see the discount at checkout."

## CSAT

- **Don't ask for a CSAT on an unresolved ticket.** The CSAT survey gates on "did we resolve your issue?" before asking for a rating. "No" reopens the ticket with the customer's reason as a new inbound; no CSAT recorded. See [[lifecycles/csat]].

## Runtime enforcement

Many of these rules are enforced live by Sonnet via `sonnet_prompts` rows tagged with `category='rule'`. To see the active rule set:

```ts
const { data } = await admin.from("sonnet_prompts")
  .select("title, category, content")
  .eq("workspace_id", workspaceId)
  .eq("enabled", true)
  .eq("status", "approved")
  .order("category").order("sort_order");
```

When this brain page diverges from the `sonnet_prompts` rows, the **runtime DB is the operational source of truth** (it's what the AI actually reads). Update both in sync. New rules should be added to the DB AND documented here.

## Related

[[lifecycles/ai-multi-turn]] · [[lifecycles/ticket-lifecycle]] · [[lifecycles/social-comment-moderation]] · [[lifecycles/cancel-flow]] · [[lifecycles/csat]] · [[tables/sonnet_prompts]] · [[tables/policies]] · [[tables/ai_personalities]] · [[tables/ai_channel_config]]
