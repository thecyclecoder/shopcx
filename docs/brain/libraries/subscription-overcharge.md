# libraries/subscription-overcharge

Subscription **overcharge detection + remediation plan**. Read-only detection of renewals that charged above the customer's grandfathered/established rate, plus the deterministic refund→heal→reply playbook the orchestrator and escalation-triage solver run. Never moves money or mutates a sub — it emits the signal and the action sequence; the existing gated/logged executors do the work.

**File:** `src/lib/subscription-overcharge.ts`

## The two overcharge shapes

1. **Prior steady-state renewal** — the latest renewal's per-unit realized price is materially (≥ $1 **and** ≥ 2%) above the lowest rate the customer was reliably paying on earlier renewals (silent price creep).
2. **Dropped grandfathered base** — the sub's effective per-unit is now **≥ MSRP** while order history shows a **lower locked rate** (`baseline < MSRP×0.75`). This is the `pricingPolicy: null` landmine [[appstle-pricing]] heals: the base was dropped and the customer pays full retail on a sub that used to be discounted. Sets `dropped_base: true`.

## Money-safety guardrail

The established baseline is **clamped UP to the 50%-MSRP floor** — we never propose restoring a customer below the floor the pricing cleanup raised everyone to ([[../tables/policies]] subscription pricing, [[../operational-rules]]). If the floor-clamp eats the delta, no overcharge is emitted. This keeps detection from ever contradicting the active floor policy.

## The sanctioned source rule

**The computed rate is the ONLY sanctioned source for a price correction. An agent may TRIGGER a correction, but may not AUTHOR the number.** This is the invariant that closes the r.aycock overcharge failure (2026-08-01, spec [[../specs/a-price-correction-must-use-the-computed-rate-not-an-agents-arithmetic]]) — where Sol set a customer's locked rate to their prior renewal's ORDER TOTAL ($54.78) instead of the computed per-unit rate ($44.95), refunded against the same wrong baseline, and silently overwrote a correct restore. The rule was already stated in this file ("per-unit comparison only — never order totals") and the deterministic detector obeyed it; nothing enforced it at the point money moves. `deriveRestoreBase` is that enforcement — it is the sanctioned source, and it lives in this module so the detector and the write-side use the same baseline.

- The **sanctioned source** for `update_line_item_price` is `deriveRestoreBase`, which reads `restore_base_cents` off the signal `detectOvercharge` computes. The `update_line_item_price` handler ([[action-executor]] line 2010, Phase 1) NEVER writes `p.base_price_cents` directly when a signal names the target variant; the signal's `restore_base_cents` wins, and the agent's number is only logged when it diverges.
- The **sanctioned source** for a paired `partial_refund` (overcharge remediation) is the same `OverchargeSignal.delta`. The `partial_refund` handler ([[action-executor]] line 2404, Phase 2) holds it in a variable named literally `overchargeDelta` and clamps the refund to that value when the agent over-asks. That is the write-side hook for phase 2: `refund_cents = min(agent_amount, overchargeDelta)` when a signal applies.
- The **audit trail** (Phase 3) is a `customer_events` row with `event_type = "subscription.line_price_changed"` emitted on every successful `update_line_item_price` write, carrying the previous realized per-unit, the new one, and the `source` label (`overcharge_signal` vs `agent_supplied`). Every refused RAISE (`raise_no_signal` or `exceeds_established`) emits a `dashboard_notifications` row for the CEO — a price increase on an existing subscriber is a decision an objective-owner should see, per the CLAUDE.md north-star rule.

## Exports

- **`detectOverchargesForCustomer(workspaceId, customerId) → OverchargeSignal[]`** — read-only. Loads active/paused subs, their renewal orders (by `subscription_id`, so a renewal on a linked profile still counts toward the baseline), the variant catalog (`product_variants` MSRP + product_id), and returns one signal per overcharged sub. Surfaced into the orchestrator account context ([[../lifecycles/subscription-billing]]) and the escalation-triage brief ([[../specs/box-escalation-triage]]).
- **`detectOvercharge(workspaceId, subscriptionId) → OverchargeSignal | null`** — single-sub variant.
- **`buildOverchargePlan(signal) → OverchargePlan`** — the deterministic playbook: `partial_refund(delta)` on the overcharging order + `update_line_item_price(restore_base_cents)` per line + `reply_points`. **Never emits migrate-to-internal** — a pricing error is healed in place.
- **`formatOverchargeForAgent(signal) → string`** — the human-readable `⚠️ OVERCHARGE DETECTED …` block (charged/expected/delta/dropped_base + per-line restore base + the remediation instruction) baked into the agent context.
- **`deriveRestoreBase({signal, contractId, variantId, agentBaseCents, project}) → RestoreBaseDecision`** — the sanctioned-source rule for `update_line_item_price`. **The agent may TRIGGER a price correction, but may not INVENT the number.** When the signal names the target variant, its `restore_base_cents` is authoritative and the agent's proposed base is only logged when it materially diverges; when no signal names the variant, the helper refuses a RAISE (`raise_no_signal`) and refuses an immaterial change on either side of the `>= $1 AND >= 2%` materiality floor (`immaterial`) — the same test used at detection. The signal path additionally confirms via the passed-in projector that the projected realized per-unit does not exceed `line.expected_per_unit` (`exceeds_established`), so an internal sub's stacked quantity break can't overshoot the established rate. The projector callback is `(proposedBaseCents: number | null) => Promise<number | null>` — runtime wraps [[pricing]] `resolveSubscriptionPricing`, unit tests pass a fixture. Consumed by [[action-executor]] `update_line_item_price`; the audit-event source label (`overcharge_signal` / `agent_supplied`) is `decision.source`, and every refused raise fires an `agent_message` [[../tables/dashboard_notifications]] row via `isRaiseAttempt(decision.refuseReason)`.
- **`isRaiseAttempt(reason) → boolean`** — true when the refused reason names a RAISE attempt (`raise_no_signal` or `exceeds_established`). The action-executor uses this to fire the CEO-visible `dashboard_notifications` escalation on the refuse path.

## Signal shape

`OverchargeSignal` carries `{ charged, expected, delta, dropped_base }` (cents) plus `subscription_id`, `shopify_contract_id`, `is_internal`, the overcharging order (`order_id`/`shopify_order_id`/`order_number`/`financial_status`), and per-line `{ variant_id, charged_per_unit, expected_per_unit, restore_base_cents }`. `restore_base_cents = round(expected_per_unit / (1 − sns%))` (sns via [[appstle-pricing]] `resolveLineSnsPct`) — the pre-discount base to lock so the realized price returns to the established rate. A fully-`refunded` order is skipped (nothing left to remediate).

## The remediation playbook (refund → heal → reply)

1. **`partial_refund`** of `delta` (`charged − expected`) on the overcharging order — gated + logged, double-refund-guarded ([[action-executor]]).
2. **`update_line_item_price`** with `restore_base_cents` — restores the grandfathered base **going forward**. Appstle subs heal in place via [[subscription-items]] `subUpdateLineItemPrice` → [[appstle-pricing]] `healOnTouch`; internal subs set `price_override_cents` (the action handler routes internal subs first now). **NEVER migrate-to-internal** as the fix — migration needs a saved Braintree PM and is for a different problem.
3. **`customer_reply`** — caught the pricing error, refunded the difference, fixed the sub, no need to cancel.

## Callers

- `src/lib/sonnet-orchestrator-v2.ts` — `getCustomerAccount` surfaces the signal; the system prompt grounds the "check overcharge before create_return/cancel" rule.
- `src/lib/agent-todos/triage.ts` — `loadTriageBrief` surfaces the signal; the [[../specs/box-escalation-triage]] skill grounds the `customer_fix` pattern.
- `src/lib/action-executor.ts` — the `update_line_item_price` handler calls `detectOvercharge` + `deriveRestoreBase` before every write (internal sub fast-path, candidate loop, and same-product self-heal), and the `partial_refund` handler calls `detectOvercharge` to clamp an over-asking refund down to the signal's `delta`. Together they enforce the sanctioned-source rule at the point money moves.

## Gotchas

- Detection needs **≥ 2 renewals** (a current + ≥ 1 prior to establish a baseline). First renewals are never flagged.
- Per-unit comparison only — never order totals (totals move with tax/shipping/qty), mirroring the orchestrator PRICE COMPARISON RULE.
- Draft orders (`source_name = shopify_draft_order`) are excluded from the baseline and the "current" renewal.
- `restore_base_cents` ignores quantity-break tiers (uses the sns factor only); the historical realized rate already bakes the break in, so a break-priced line restores slightly high — acceptable and customer-favorable, but note it if a sub has aggressive qty breaks.

---

[[../README]] · [[appstle-pricing]] · [[subscription-items]] · [[action-executor]] · [[../lifecycles/subscription-billing]] · [[../specs/box-escalation-triage]] · [[../tables/policies]] · [[../../CLAUDE]]
