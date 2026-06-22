# libraries/subscription-overcharge

Subscription **overcharge detection + remediation plan**. Read-only detection of renewals that charged above the customer's grandfathered/established rate, plus the deterministic refund→heal→reply playbook the orchestrator and escalation-triage solver run. Never moves money or mutates a sub — it emits the signal and the action sequence; the existing gated/logged executors do the work.

**File:** `src/lib/subscription-overcharge.ts`

## The two overcharge shapes

1. **Prior steady-state renewal** — the latest renewal's per-unit realized price is materially (≥ $1 **and** ≥ 2%) above the lowest rate the customer was reliably paying on earlier renewals (silent price creep).
2. **Dropped grandfathered base** — the sub's effective per-unit is now **≥ MSRP** while order history shows a **lower locked rate** (`baseline < MSRP×0.75`). This is the `pricingPolicy: null` landmine [[appstle-pricing]] heals: the base was dropped and the customer pays full retail on a sub that used to be discounted. Sets `dropped_base: true`.

## Money-safety guardrail

The established baseline is **clamped UP to the 50%-MSRP floor** — we never propose restoring a customer below the floor the pricing cleanup raised everyone to ([[../tables/policies]] subscription pricing, [[../operational-rules]]). If the floor-clamp eats the delta, no overcharge is emitted. This keeps detection from ever contradicting the active floor policy.

## Exports

- **`detectOverchargesForCustomer(workspaceId, customerId) → OverchargeSignal[]`** — read-only. Loads active/paused subs, their renewal orders (by `subscription_id`, so a renewal on a linked profile still counts toward the baseline), the variant catalog (`product_variants` MSRP + product_id), and returns one signal per overcharged sub. Surfaced into the orchestrator account context ([[../lifecycles/subscription-billing]]) and the escalation-triage brief ([[../specs/box-escalation-triage]]).
- **`detectOvercharge(workspaceId, subscriptionId) → OverchargeSignal | null`** — single-sub variant.
- **`buildOverchargePlan(signal) → OverchargePlan`** — the deterministic playbook: `partial_refund(delta)` on the overcharging order + `update_line_item_price(restore_base_cents)` per line + `reply_points`. **Never emits migrate-to-internal** — a pricing error is healed in place.
- **`formatOverchargeForAgent(signal) → string`** — the human-readable `⚠️ OVERCHARGE DETECTED …` block (charged/expected/delta/dropped_base + per-line restore base + the remediation instruction) baked into the agent context.

## Signal shape

`OverchargeSignal` carries `{ charged, expected, delta, dropped_base }` (cents) plus `subscription_id`, `shopify_contract_id`, `is_internal`, the overcharging order (`order_id`/`shopify_order_id`/`order_number`/`financial_status`), and per-line `{ variant_id, charged_per_unit, expected_per_unit, restore_base_cents }`. `restore_base_cents = round(expected_per_unit / (1 − sns%))` (sns via [[appstle-pricing]] `resolveLineSnsPct`) — the pre-discount base to lock so the realized price returns to the established rate. A fully-`refunded` order is skipped (nothing left to remediate).

## The remediation playbook (refund → heal → reply)

1. **`partial_refund`** of `delta` (`charged − expected`) on the overcharging order — gated + logged, double-refund-guarded ([[action-executor]]).
2. **`update_line_item_price`** with `restore_base_cents` — restores the grandfathered base **going forward**. Appstle subs heal in place via [[subscription-items]] `subUpdateLineItemPrice` → [[appstle-pricing]] `healOnTouch`; internal subs set `price_override_cents` (the action handler routes internal subs first now). **NEVER migrate-to-internal** as the fix — migration needs a saved Braintree PM and is for a different problem.
3. **`customer_reply`** — caught the pricing error, refunded the difference, fixed the sub, no need to cancel.

## Callers

- `src/lib/sonnet-orchestrator-v2.ts` — `getCustomerAccount` surfaces the signal; the system prompt grounds the "check overcharge before create_return/cancel" rule.
- `src/lib/agent-todos/triage.ts` — `loadTriageBrief` surfaces the signal; the [[../specs/box-escalation-triage]] skill grounds the `customer_fix` pattern.

## Gotchas

- Detection needs **≥ 2 renewals** (a current + ≥ 1 prior to establish a baseline). First renewals are never flagged.
- Per-unit comparison only — never order totals (totals move with tax/shipping/qty), mirroring the orchestrator PRICE COMPARISON RULE.
- Draft orders (`source_name = shopify_draft_order`) are excluded from the baseline and the "current" renewal.
- `restore_base_cents` ignores quantity-break tiers (uses the sns factor only); the historical realized rate already bakes the break in, so a break-priced line restores slightly high — acceptable and customer-favorable, but note it if a sub has aggressive qty breaks.

---

[[../README]] · [[appstle-pricing]] · [[subscription-items]] · [[action-executor]] · [[../lifecycles/subscription-billing]] · [[../specs/box-escalation-triage]] · [[../tables/policies]] · [[../../CLAUDE]]
