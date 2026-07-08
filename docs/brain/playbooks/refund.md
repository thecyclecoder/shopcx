# Refund

Handles customers who were charged for a subscription renewal they didn't expect or want. The most-fired playbook by volume — sub-renewal disputes are the dominant subscription-side conflict.

DB row in [[../tables/playbooks]]: `name='Refund'`, `priority=100`, `exception_limit=2`, `stand_firm_max=3`, `stand_firm_before_exceptions=2`, `stand_firm_between_tiers=2`, `disqualifier_behavior='silent'`.

## Trigger

- **trigger_intents**: `refund_request`, `return_request`, `money_back`, `30_day_guarantee`, `unwanted_charge`, `subscription_dispute`, `charged_without_permission`, `unauthorized_charge`
- **trigger_patterns**: "charged without permission", "didn't sign up for subscription", "didnt sign up", "unauthorized charge", "charged me again", "stop charging me", "didn't order this", "didnt order", "cancel and refund", "want my money back", "refund me", "charged for an order I didn", "never signed up", "didn't want this order", "order I didn't make", "order I didnt make", "subscription I didn't want"
- **priority**: 100 (highest active)

## Steps

8 steps. step_order is the canonical sequence:

| Order | type | Name |
|---|---|---|
| 0 | `identify_order` | Identify the order |
| 1 | `identify_subscription` | Identify the subscription |
| 2 | `check_other_subscriptions` | Check for other active subscriptions |
| 3 | `apply_policy` | Explain the situation and policy |
| 4 | `offer_exception` | Offer exception if eligible |
| 5 | `initiate_return` | Initiate the return |
| 6 | `cancel_subscription` | Cancel the subscription |
| 7 | `stand_firm` | Stand firm if all offers rejected |

The order matters: identify order → identify sub → check for other subs → explain policy with a real timeline → only THEN offer an exception → if accepted, initiate the return + cancel → if rejected, stand firm.

## Policy

One row in [[../tables/playbook_policies]]:

- **30-Day Return Policy** — supersedes most workspaces' default policy. The canonical version lives in [[../tables/policies]] (slug=`returns` + slug=`refunds`) — the playbook references those for the customer-facing policy link.

Current policy contract:

- Renewal orders are **not eligible for return** (the customer agreed to recurring billing).
- First orders ARE eligible within 30 days.
- Damaged / wrong item / missing items go through the [[replacement-order]] playbook, not this one.

## Exceptions (3 tiers)

[[../tables/playbook_exceptions]] rows:

### Tier 1 — Return for Store Credit

- **conditions**: customer LTV ≥ $100 OR total orders ≥ 3 (long-tenured).
- **resolution_type**: `store_credit_return` (customer returns the product, gets store credit, NOT a refund to original card).
- Used as the first exception offer. Lower friction for us — store credit stays in our economy.

### Tier 2 — Return for Full Refund

- **conditions**: customer LTV ≥ $2,000 OR total orders ≥ 5 (very tenured). _Threshold tightened 2026-06-05 from $300 / 3 orders — only true high-LTV customers escalate to a cash refund._
- **resolution_type**: `refund_return` (full refund to original card).
- Reserved for customers we don't want to lose, where store credit alone would push them out.
- **Standalone offer is firm.** When the executor advances from Tier 1 to Tier 2 it does NOT re-offer Tier 1 first — Tier 1 has already been rejected. The reply restates the Tier 2 offer with the same exact math and a clear CTA.

> **Auto-grant feature removed 2026-06-03.** A previous tier-0 "System Error → Refund Without Return" exception with `auto_grant=true` existed; the detection logic was stubbed and never shipped. Sonnet escalates these scenarios directly when they come up, and `never_delivered` is handled by the replacement flow. The legacy DB row is preserved but dormant — the executor filters `!auto_grant` defensively.

## Disqualifiers (`disqualifier_behavior='silent'`)

- **previous_exception** — customer got a playbook exception before → blocks `exceptions_only`. In-policy returns still allowed.
- **has_chargeback** — customer has any chargeback → blocks `exceptions_only`.
- **has_chargeback_on_order** — chargeback on THIS specific order → blocks even `in_policy_return`.

`silent` means the customer never hears "we can't offer an exception" — the playbook simply doesn't tier up. They go straight to stand firm.

## Stand-firm escalation

`stand_firm_before_exceptions=2` + `stand_firm_between_tiers=2` + `stand_firm_max=3`:

- After explaining the policy (step 3), if customer pushes back, stand firm up to 2 times before tiering up to an exception offer.
- Between exception tiers (Tier 1 → Tier 2), stand firm up to 2 times **then advance** — the executor resets `exception_stand_firm_count`, finds the next eligible tier via `evaluateCustomerConditions`, and offers it. The model must NOT keep re-quoting Tier 1 forever; once the counter exhausts, the next turn is Tier 2 (or final stand-firm if customer doesn't qualify).
- Total stand-firm reps capped at 3 before AI declares the conversation closed.

Final stand firm format: one sentence + "reply if you change your mind." See [[../playbooks/README]].

## Communication rules specific to this playbook

- **Never apologize for the charge** the customer signed up for — duplicate-sub charges aren't billing errors. See feedback_no_apology_for_customer_action.
- **Never frame multiple subs as "double billing"** — customer made the subs, we processed them as configured. See feedback_no_double_billing_framing.
- **Cancel detection is global** — if the customer mentions cancel mid-flow, pause + launch [[../journeys/cancel]] + don't mention the refund again until they bring it back up.
- **Never end an exception offer with "does that work for you?"** (or "is that acceptable", "would that be okay", etc.) — that phrasing implies we have a better offer waiting if the customer says no. We don't. Present the exception as our best offer and end with a direct CTA to proceed ("Want me to send the return label?"). See feedback_no_conditional_exception_phrasing.
- **Never quote a number from the customer's own message as the active offer.** Customers cite reward-point balances, prior credit, or guesses ($X they mention) — those are NOT the active offer ($Y you just quoted). The active offer comes from the prior AI turn or `playbook_context.net_refund_cents`. If the customer's number differs, address it as a separate balance ("your reward points are separate from this offer") — never silently overwrite the active number with theirs.
- **Always acknowledge a return-label question.** If the customer asks "how do I get my return label" / "send me a label" / similar, the next turn must address it directly — either by sending the label (offer accepted) or by explaining the next step before they get one. Ignoring the question reads as dismissive and is one of the top causes of escalation.
- **Never accept "return to sender" / "refuse delivery" as a return mechanism.** Returns are processed ONLY via a label WE generate (EasyPost, with tracking — `createFullReturn`, step 5). We cannot track or match an untracked refused package to an order, so **no refund or credit can ever be issued for a return-to-sender.** If the customer proposes it, say plainly we can't track/refund those and that you'll send a proper return label instead. One approved exception = one label for one order — never let a customer return-to-sender multiple packages expecting multiple refunds (we'd be unable to refund any of them). Canonical rule lives in [[../tables/policies]] (slug=`returns` § Return Mechanism). _Root cause: ticket cab25c8c (Magan Geib, 2026-06-15) — a stand-firm turn freelanced a full-refund offer, the acceptance was misrouted out of the playbook as a "new topic," and the guardrail-free orchestrator agreed to a return-to-sender refund._
- **Acknowledge hardship with empathy only — never a "make it right" promise.** When the customer's opening carries a hardship/distress signal (hospitalization, illness, bereavement, financial strain), step 0 (`identify_order`) and step 3 (`apply_policy`) lead with ONE warm, genuine line — e.g. *"I'm so sorry to hear your wife has been in the hospital — I hope she's doing okay."* — then go straight into the facts. The acknowledgment is pure human warmth: it must NOT say "we'll make it right," "let me take care of this," or imply/promise any refund, exception, or outcome (the policy is decided on its facts, and the playbook may still stand firm). And the explanation must be plain human language, NOT a mechanical date-by-date account ledger ("January 1… May 21… June 19"). _Root cause: ticket cc3d6b9b (2026-06-19) — the opening was a cold timeline recap that ignored the wife's 13-day hospitalization. Hardship adjusts TONE only; the offer ladder is unchanged (see [[../operational-rules]] § Returns)._
- **Never offer or tease an exception during a stand-firm turn.** Stand-firm (pre-exception, tier 0) restates ONLY the policy. Phrases like "I'd like to make this right" / "let me see what I can do" pre-announce an offer the system hasn't authorized and let the model pick the wrong (over-generous) resolution. The executor — not the model — decides when and which tier is offered. Hardened in `playbook-executor.ts` stand-firm prompt.
- **Pause step is skipped when the identified subscription is already cancelled.** A `pause_subscription` (or `pause`) step guards on the target sub's status via `decidePauseSubscriptionStep` in `playbook-executor.ts`: if the sub matched by `identified_subscription` is `cancelled`, the step advances with NO action and NO customer-facing response — the claim-guard has nothing to block. If the sub is active or paused, the step still fires appstle pause + confirms with `backedActions: ["pause_timed", "pause"]` so the reply is backed. _Root cause: ticket 472310cc — the Refund playbook tried to pause an already-cancelled sub, the pause claim was unbacked, and the step-level claim-guard blocked the send and dead-ended in escalation instead of advancing._

## Customer-facing formatting

From [[../playbooks/README]] universal patterns:

- Refer to orders by date + amount ("your April 4th order for $5.87"). Never the order number.
- Timeline format for first policy explanation:
  ```
  <p><b>March 25</b><br>You subscribed and your first order shipped.</p>
  <p><b>April 4</b><br>Your renewal order processed.</p>
  ```
- Exception offer is one paragraph with exact math + direct CTA to proceed. Example: "I was able to get a one-time return exception approved in your situation: ship the product back and you'll get $5.87 in store credit ($6.49 order total minus the $0.62 return label). Want me to send the label?" — note the CTA is asking permission to set it up, NOT asking whether the offer is acceptable. See § Communication rules above.

## Files

| File | Purpose |
|---|---|
| `src/lib/playbook-executor.ts` | Step engine running this playbook |
| `src/lib/shopify-returns.ts` | createFullReturn for step 5 (initiate_return) |
| `src/lib/store-credit.ts` | Store credit issuance for Tier 1 |
| `src/lib/appstle.ts` | subscription cancel for step 6 |
| `src/lib/customer-events.ts` | Event logging |
| `src/lib/improve-actions.ts` | Agent override actions (apply exception manually, force-stand-firm) |
| `src/lib/inngest/returns.ts` | Refund / store-credit pipeline kicked off after step 5 |
| `src/app/dashboard/settings/playbooks/page.tsx` | Settings UI for editing this playbook |

## Related

[[../README]] · [[replacement-order]] · [[../tables/playbooks]] · [[../tables/playbook_policies]] · [[../tables/playbook_exceptions]] · [[../tables/policies]] · [[../tables/returns]] · [[../tables/store_credit_log]] · [[../tables/subscriptions]] · [[../tables/chargeback_events]] · [[../journeys/cancel]] · [[../journeys/select-subscription]] · [[../lifecycles/return-pipeline]] · [[../lifecycles/cancel-flow]] · [[../integrations/shopify]] · [[../integrations/appstle]] · [[../integrations/braintree]]
