# open-tickets

**When:** the founder wants to work the open-ticket queue — "how many open tickets", "what's in my queue", "walk me through the open tickets", "/open-tickets". This is the founder's *working* loop for support: one ticket at a time, decide, move on.

**Why:** in steady state **every OPEN ticket should be escalated to the CEO.** The autonomous lanes close what they can resolve, so a ticket that is still open is by definition one that Sol couldn't finish and June couldn't rule on. That makes the queue small and high-signal — and it makes an *unescalated* open ticket a **defect**, not a queue item: something dropped it. The founder shouldn't have to notice that by eye.

The second reason: **Sol's and June's write-ups are claims, not ground truth, and they have been wrong on load-bearing facts.** On 2026-08-03 two of two founder escalations were materially wrong:

- **Julianne / SC134986** — June reported "paid but UNFULFILLED — QC-verified never shipped." The order had shipped 7/29 and **delivered that same day**. The order carried *two* tracking numbers and she matched the return label instead of the outbound one. A phantom-return cleanup got escalated as a fulfillment failure.
- **Loretta / ACV Gummies** — June reported a "silent renewal failure" heading for 216 more subs and asked the founder to declare an OOS crisis. Appstle simply skips an out-of-stock line: the renewal **succeeded** and billed $6.00 of shipping protection. Nobody was charged for undeliverable product. The real issue was one $6.00 charge on an empty shipment.

Both would have produced a wrong founder decision if taken at face value. So this skill's core discipline is: **read what Sol and June said, then verify every load-bearing number against the live rows before you summarise.**

**Source of truth = [[../../../src/lib/tickets-read]]** (`investigateTicket`) for the ticket / messages / Direction picture — never raw `.from("tickets")` (CLAUDE.md read discipline). June's verdicts come from `director_activity` (`director_function='cs'`, `action_kind='cs_director_call'`); the founder card from `dashboard_notifications`.

## Procedure

### 1. List the queue

```sh
npx tsx scripts/open-tickets.ts list
```

Per ticket: customer · subject · age · idle · **escalation health** · how many June verdicts exist · open CEO cards.

**Read the escalation health line first.** `⚠️ DEFECT — open Nh, NOT escalated` means an open ticket past the 30-minute just-created grace that nobody escalated. That is a pipeline bug (a dropped hand-off), not a customer problem — surface it to the founder separately from the queue itself, and investigate why the lane dropped it.

### 2. Take ONE ticket. Never batch.

```sh
npx tsx scripts/open-tickets.ts show <ticket-id>
```

That prints, in order: the **customer's own messages** (ground truth), **Sol's Directions**, **June's verdicts** (full reasoning), then the customer's live **subscriptions / orders / returns** — the rows the claims must be checked against.

### 3. Verify before you summarise — this is the step that matters

Take each load-bearing claim in Sol's or June's narrative and check it against a live row. Do not pass an agent's number through as fact ([[../../../docs/brain/operational-rules]] — label verified vs estimated).

Specifically re-check:

- **"never shipped" / "unfulfilled"** → read `fulfillments`, `amplifier_status`, `amplifier_shipped_at`, `delivery_status`, `delivered_at`. **An order can carry more than one tracking number** — confirm which is outbound and which is a return label before concluding anything.
- **"billing failed" / "will fail"** → find the actual renewal order. Appstle *skips* an out-of-stock line rather than failing the charge, so a "failed renewal" is often a succeeded charge for the remaining lines.
- **any count ("254 subs", "216 renewing")** → recount it yourself, and split **overdue** (`next_billing_date` in the past) from **genuinely upcoming**. An aggregate that mixes them overstates urgency.
- **a price / floor / grandfathered rate** → check the real order history. A rate "a prior agent promised" may have no basis in any historical order.
- **stock claims** → `product_variants.inventory_quantity` + its `updated_at`, and whether a `crisis_events` row actually exists.
- **anything that looks impossible** — a $0.00 active subscription, a `variant_id` that's a UUID instead of a Shopify id, an order marked `fulfilled` with no outbound tracking. Chase it; these are usually the real story.

If the verification contradicts the escalation, **say so plainly** — that is the most valuable output this skill produces.

### 4. Bring the founder a TINY summary + a choice

Keep it short. The founder does not want the investigation, only what's true and what to do:

- **2–4 lines max** — what the customer actually wants, what's really true (with the corrected facts if an agent was wrong), and what's blocking.
- Then **AskUserQuestion** with 2–4 concrete options, each naming the real action and its consequence. Recommend one and mark it `(Recommended)`.
- The tool always offers "Other" — the founder can direct something completely different. Say so if the options feel narrow.

Then execute the choice, verify it landed, and move to the next ticket.

## Guardrails

- **Read-only until the founder chooses.** `list` and `show` mutate nothing. No reply, refund, cancel, or close before an explicit decision.
- **One ticket at a time.** Don't dump the whole queue with options — that's the thing this replaces.
- **Never present an agent's claim as fact.** If you didn't verify it this session, label it as June's/Sol's claim.
- **Execute through the chokepoints**, never raw writes: `directActionHandlers` / `executeSonnetDecision` (refunds, coupons, account actions), `subscriptionAction` (pause/cancel/resume), `sendThreadedReply`, `closeTicket`. See [[run-orchestrator-action]] and [[customer-remedy]].
- **Order actions so a failure can't lie to the customer.** Do the money/account mutation FIRST and abort before the reply if it fails — never tell someone you refunded them when the refund errored.
- **Customer-facing text follows [[../../../docs/brain/customer-voice]]** — plain text, no markdown, ≤2 sentences per paragraph, mirror their language, no reflexive apology, sign with the persona already on the thread.
- **An unescalated open ticket is a defect to report**, not one to quietly escalate and move past.

## Related

- `scripts/open-tickets.ts` — the runnable this skill drives (`list` · `show`)
- [[investigate-ticket]] — deeper single-ticket forensics (turn-by-turn, silent-turn detection) when `show` isn't enough
- [[ceo-approvals]] — the approvals inbox; a ticket escalation usually has a card there too
- [[customer-remedy]] · [[run-orchestrator-action]] — executing the chosen remedy
- [[../../../src/lib/tickets-read]] · [[../../../src/lib/tickets-reply]] · [[../../../src/lib/tickets-mutate]]
- [[../../../docs/brain/libraries/cs-director]] — June's leash: what she may rule vs must escalate
- [[../../../docs/brain/customer-voice]] — the reply rules
