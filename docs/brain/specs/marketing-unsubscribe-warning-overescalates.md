# get_customer_account no-shopify-id warning over-escalates already-unsubscribed empty shells ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `3d828685-6724-463c-af3f-3e2b00e12f3f`

Ticket 3d828685 (Donald Owen) escalated even though the customer has zero orders, zero subscriptions, and is already not_subscribed on both email and SMS. The escalation was caused entirely by the marketing-consent line in get_customer_account, which appends '[WARNING: no shopify_customer_id — unsubscribe actions cannot push to Shopify; escalate so a human can remove from any external lists]' unconditionally whenever shopify_customer_id is null. That literal 'escalate' instruction in tool output overrode every deterministic and sonnet_prompt rule. Make the hint conditional on there actually being something to unsubscribe.

## Problem (from escalated ticket `3d828685-6724-463c-af3f-3e2b00e12f3f`)
In src/lib/sonnet-orchestrator-v2.ts (~line 858) the MARKETING CONSENT context line is built as: parts.push(`MARKETING CONSENT: email=${emailStatus}, sms=${smsStatus}${noShopify ? ' [WARNING: ... escalate so a human can remove from any external lists]' : ''}`). The warning fires whenever noShopify is true, ignoring (a) whether either channel is actually subscribed/unknown (i.e. there is anything to remove) and (b) whether the customer has any orders/subscriptions at all. For a true empty shell that is already not_subscribed on both channels, this tells the orchestrator to escalate when the correct behavior is a reply: there is nothing to unsubscribe and nothing to cancel, and recurring charges the customer describes are not ours. Fix: only emit an escalation-flavored hint when noShopify AND at least one channel is 'subscribed'/'unknown' (a real unsubscribe we cannot push); when both channels are already not_subscribed, emit a plain note that the customer is already fully unsubscribed and no action is possible/needed. Reword the hint to decouple 'cannot push to Shopify' from 'escalate' so the orchestrator reaches for a reply (per the No-data-guard, Validate-validatable-claims, and ground-truth-wins rules) before escalating. Add the no-orders/no-subs empty-shell case to the reply path rather than the escalate path.

**Likely target:** `src/lib/sonnet-orchestrator-v2.ts (marketing-consent context builder, ~line 849-859)`

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `3d828685-6724-463c-af3f-3e2b00e12f3f`. Commission the build from the Roadmap board (owner = cs).
