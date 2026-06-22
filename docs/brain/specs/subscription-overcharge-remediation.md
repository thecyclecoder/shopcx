# Subscription Overcharge Remediation (detect → refund → heal → reply) ⏳

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity". The capability the system *should* have had when Jim Leone's ticket (`21b8c370`) escalated.

**What happened (the miss).** Jim's active 4× Amazing Coffee sub lost its grandfathered pricing → Appstle billed **$229.26** instead of his **$139.84** (renewal `SC133086`). He asked to "cancel." Instead of recognizing an **overcharge from dropped grandfathered pricing**, the orchestrator fired `create_return` (failed — nothing fulfilled), escalated, and the triage routine authored a spec to *build order-cancellation* — a capability we forbid by policy and that solves nothing. **The right response was: discover the pricing issue → partial-refund the overcharge → heal the sub so it bills correctly → reply.** (Done by hand for Jim: refunded $89.42, healed the Appstle line basePrice to $46.61 → $139.84/4.)

Make that a first-class, automatable remediation.

## Detection
A subscription renewal is **overcharged** when its charged total is materially above the customer's **established/grandfathered price** for that sub — the prior steady-state renewal amount, or a grandfathered base that was dropped (Appstle line `basePrice` reverted to MSRP / `price_override_cents` lost). Signal: latest renewal total > the trailing renewal baseline by a threshold, **and** the sub's current effective per-unit price ≥ MSRP while history shows a lower locked rate. Surface it as a structured finding (`overcharge_detected` with `charged`, `expected`, `delta`, the dropped grandfathered base).

## Remediation (the orchestrator action / playbook + the triage proposal)
For a confirmed overcharge:
1. **Partial refund the delta** — `partial_refund` of `charged − expected` on the overcharging order (gated; logged per the North Star).
2. **Heal the sub going forward** — restore the grandfathered base via the **Appstle pricing-policy heal** (`subUpdateLineItemPrice` → `healOnTouch`, `src/lib/appstle-pricing.ts` / `subscription-items.ts`), so the next renewal bills the locked rate. **Never** migrate-to-internal as the fix when there's no saved Braintree PM — heal on Appstle. (Internal subs: restore `price_override_cents`.)
3. **Reply** — tell the customer we caught the pricing error, refunded the difference, and corrected their subscription; **no cancellation needed**. (This is the answer to a "cancel my order" ticket that's really an overcharge.)

## Triage / orchestrator grounding (so it stops mis-diagnosing)
- The orchestrator + the escalation-triage solver must **check for an overcharge** on any subscription "cancel / refund / wrong price / charged too much" ticket **before** reaching for `create_return`/cancel — and propose the remediation above.
- **Never author a `code_gap` spec that contradicts an existing policy/rule.** Before proposing to *build* a capability, ground against [[../tables/policies]] + [[../operational-rules]] — e.g. the new **order-cancellation** policy (no cancel/refund after placement) means "we can't cancel" is a **policy to communicate**, not a feature to build. A failed direct action that's really a policy/pricing situation → a **customer_reply** (+ the remediation), not a build-the-feature spec.
- Always propose a **customer_reply for the immediate ticket**, even when escalating a genuine code gap — the customer is never left with silence + a spec file.

## Verification
- A sub whose renewal billed above its grandfathered baseline → `overcharge_detected` fires; the proposed remediation = partial_refund(delta) + Appstle pricing-policy heal + a customer_reply (no cancel/return). Approve → refund issued, `subUpdateLineItemPrice`/`healOnTouch` restores the base (next renewal bills the locked rate), reply drafted.
- A "cancel my order" ticket on an overcharged sub → triage proposes the remediation, **not** `cancel-order`/`create_return`; the order-cancellation policy is cited if the customer wants out regardless.
- Negative: a sub billing at its correct/expected price → no overcharge flagged; triage never authors a spec that contradicts an active policy; no customer ticket ends with only a spec file.

## Phase 1 — detection + remediation playbook + triage grounding ⏳
The `overcharge_detected` signal (renewal vs grandfathered baseline / dropped base); the remediation playbook (partial_refund delta + Appstle pricing-policy heal + reply) wired into the orchestrator + the escalation-triage solver; the grounding rules (check overcharge before cancel/return; never code_gap against a policy; always a customer_reply). Brain: [[../libraries/appstle-pricing]] · [[../libraries/subscription-items]] · [[box-escalation-triage]] · [[../lifecycles/subscription-billing]] · [[../tables/policies]] (order-cancellation).
