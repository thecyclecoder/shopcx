# Subscription Overcharge Remediation ✅

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity"

A subscription renewal can charge a customer **above** the rate they were grandfathered/established at — a silent price creep, or a dropped grandfathered base now billing at/above MSRP (the `pricingPolicy: null` landmine [[../libraries/appstle-pricing]] heals). Today a customer who notices this opens a "cancel / refund / wrong price" ticket, and the orchestrator (or the escalation-triage solver) can reach for `create_return` or `cancel` instead of the real fix: **refund the difference and heal the sub**. This spec adds detection + a remediation playbook + the triage/orchestrator grounding so the overcharge is caught and fixed without a cancel.

## North star (supervisable autonomy)

Detection is a **bounded, read-only proxy** — it surfaces a `{charged, expected, delta, dropped_base}` signal and a deterministic action plan; it never moves money or mutates a sub. The orchestrator / triage solver (objective owner) supervise it, and every money action runs through the existing **gated, logged** executors (`partial_refund` is double-refund-guarded and Slack-notified; triage `customer_action`s are human-approved). The 50%-MSRP floor and the order-cancellation policy are **rails**: detection clamps to the floor and the solver never authors a spec that contradicts an active policy. CEO → Retention/CS → tool.

## Phase 1 — detection, remediation playbook, triage/orchestrator grounding ✅

### Detection (`overcharge_detected` signal) ✅
`src/lib/subscription-overcharge.ts` — `detectOverchargesForCustomer(workspaceId, customerId)` (read-only) returns one `OverchargeSignal` per overcharged active/paused sub. Two shapes:
- **prior steady-state renewal** — latest renewal per-unit ≥ $1 **and** ≥ 2% above the lowest reliably-paid prior-renewal rate;
- **dropped grandfathered base** — effective per-unit ≥ MSRP while history shows a lower locked rate (`baseline < MSRP×0.75`) → `dropped_base: true`.

Emits `{charged, expected, delta, dropped_base}` (cents) + the overcharging order + per-line `{variant_id, charged_per_unit, expected_per_unit, restore_base_cents}`. Baseline clamped UP to the 50%-MSRP floor (never restore below the policy floor); fully-refunded orders skipped; needs ≥ 2 renewals.

### Remediation playbook ✅
`buildOverchargePlan(signal)` returns the deterministic sequence the agent runs through existing gated executors:
1. `partial_refund(charged − expected)` on the overcharging order ([[../libraries/action-executor]]).
2. `update_line_item_price(restore_base_cents)` per line — restores the grandfathered base going forward: Appstle heal in place (`subUpdateLineItemPrice → healOnTouch`, [[../libraries/subscription-items]] / [[../libraries/appstle-pricing]]) or `price_override_cents` for internal subs. The `update_line_item_price` direct action now **routes internal subs first** (the Appstle config/lineId path would otherwise fail for them). **NEVER migrate-to-internal** as the fix.
3. `customer_reply` — caught the pricing error, refunded the difference, fixed the sub, no cancel needed.

### Triage + orchestrator grounding ✅
- **Orchestrator** ([[../libraries/subscription-overcharge]] callers, `sonnet-orchestrator-v2.ts`): `getCustomerAccount` surfaces the `⚠️ OVERCHARGE DETECTED` block; the system prompt adds the "check overcharge BEFORE create_return/cancel → refund + heal + reply, never migrate-to-internal" rule.
- **Escalation-triage** ([[box-escalation-triage]]): `loadTriageBrief` surfaces the same block; the skill adds the overcharge `customer_fix` pattern + two rails — (a) never author a spec that contradicts an active policy ([[../tables/policies]]), (b) always propose a `customer_reply` for the immediate ticket even when escalating a code gap.

## Safety / invariants

- **Read-only detection.** The detector and `buildOverchargePlan` never mutate; money/sub changes go through the gated `partial_refund` / `update_line_item_price` handlers.
- **Floor rail.** Established baseline clamped to 50%-MSRP floor — remediation never restores below the floor the pricing cleanup set ([[../tables/policies]]).
- **Never migrate-to-internal.** A pricing error is healed on Appstle (or via internal `price_override_cents`); migration needs a saved Braintree PM and solves a different problem.
- **Never spec against a policy.** "We can't cancel a shipped order" is a `customer_reply` invoking the cancellation policy, not a code gap.
- **Per-unit only.** Compare per-unit realized prices, never order totals.

## Completion criteria

- `detectOverchargesForCustomer` returns the `{charged, expected, delta, dropped_base}` signal for both overcharge shapes. ✅
- The signal is surfaced into the orchestrator account context and the triage brief. ✅
- The orchestrator + triage are grounded to check overcharge before cancel/return, run refund→heal→reply, and never migrate-to-internal / never spec against a policy. ✅
- `update_line_item_price` restores the base for both Appstle and internal subs. ✅
- `npx tsc --noEmit` clean. ✅

## Verification

- On `src/lib/subscription-overcharge.ts`, run the non-destructive harness (import `detectOverchargesForCustomer` / `buildOverchargePlan`) against a customer with a known price creep → expect one `OverchargeSignal` with `charged`/`expected`/`delta` matching the per-unit jump × qty and a `partial_refund` + `update_line_item_price` plan.
- On a customer whose renewals are all the same per-unit → expect `detectOverchargesForCustomer` returns `[]` (no false positive).
- On a customer whose historical price was **below** the 50%-MSRP floor and was raised to the floor → expect NO signal (floor-clamp ate the delta; this is the cleanup, not an overcharge).
- On a sub with a dropped grandfathered base (current per-unit ≥ MSRP, history shows a discounted rate) → expect a signal with `dropped_base: true`.
- In a chat/email ticket "I was overcharged on my renewal" for an overcharged customer → expect the orchestrator to emit `partial_refund` + `update_line_item_price` + a reply that says the difference was refunded and the sub fixed, and NOT a `create_return` or cancel.
- In the hourly escalation-triage sweep over an escalated overcharge ticket → expect the solver to propose a `customer_fix` with `partial_refund` + `update_line_item_price` + `customer_reply`, never a migrate-to-internal action and never a spec that contradicts the cancellation policy.
- On an **internal** sub, run `update_line_item_price {contract_id, variant_id, base_price_cents}` via the executor → expect `subscriptions.items[].price_override_cents` set to `base_price_cents` (no "Appstle not configured" error).
- On an **Appstle** sub with no saved Braintree PM, remediation → expect the base restored via the Appstle pricing-policy heal (no migrate-to-internal attempted).

## Brain updates (same PR)

[[../libraries/subscription-overcharge]] (new) · [[../libraries/appstle-pricing]] · [[../libraries/subscription-items]] · [[box-escalation-triage]] · [[../lifecycles/subscription-billing]] · [[../tables/policies]].

## Related

[[../libraries/subscription-overcharge]] · [[../libraries/action-executor]] · [[../libraries/subscription-items]] · [[../libraries/appstle-pricing]] · [[../lifecycles/subscription-billing]] · [[box-escalation-triage]] · [[../tables/policies]] · [[../functions/retention]] · [[../functions/cs]]
