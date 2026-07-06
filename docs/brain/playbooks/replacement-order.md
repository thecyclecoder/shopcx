# Replacement Order

Handles order replacements for delivery errors, missing/damaged items, expired items, and wrong addresses. Creates a fresh Shopify order at no cost to the customer when eligible.

DB row in [[../tables/playbooks]]: `name='Replacement Order'`, `priority=50`, `exception_limit=0`, `stand_firm_max=0`.

## Trigger

- **trigger_intents**: `missing_items`, `not_received`, `damaged_items`, `where_is_my_order`, `expired_items`
- **trigger_patterns**: empty (the orchestrator + Sonnet pick intent classification)
- **priority**: 50

## Steps

8 steps, in canonical order:

| Order | type | Name |
|---|---|---|
| 0 | `clarify_issue` | Clarify Issue |
| 1 | `identify_order` | Identify Order |
| 2 | `check_tracking` | Check Tracking |
| 3 | `classify_issue` | Classify Issue |
| 4 | `select_missing_items` | Select Missing Items |
| 5 | `confirm_shipping_address` | Confirm Shipping Address |
| 6 | `create_replacement` | Create Replacement Order |
| 7 | `adjust_subscription` | Adjust Subscription |

### Step 0 — clarify_issue

Open-ended Sonnet turn to make sure we understand the issue type. Is it missing entirely, damaged, expired, or wrong items? Determines which downstream steps fire.

### Step 1 — identify_order

Disambiguate which order. If the customer has only one recent unfulfilled or recent-delivered order, auto-select. Otherwise show recent orders by date + amount (never the order number).

### Step 2 — check_tracking

Call EasyPost (and Shopify fulfillment data) for the identified order:

- **Delivered** but customer didn't receive → wait period before we treat as lost. See feedback_porch_pirate logic if applicable.
- **In transit** beyond reasonable window → treat as lost.
- **Carrier shows delivered to wrong address** → automatic eligibility for replacement.

The tracking outcome classifies the case for the next step.

### Step 3 — classify_issue

Sonnet narrows the issue:

- `missing_items` — partial items missing from a delivered order.
- `not_received` — entire order lost in transit.
- `damaged_items` — arrived damaged.
- `wrong_address` — delivered to a different address.
- `expired_items` — short-dated or expired stock.

Different sub-types take different paths through steps 4-6.

### Step 4 — select_missing_items

Launches [[../journeys/missing-items]]. Customer ticks the missing items + quantities. Skipped if the entire order is missing (not_received) or for damaged-items where we just replace everything.

### Step 5 — confirm_shipping_address

Launches [[../journeys/shipping-address]]. Critical when the original delivery failed at the address level — re-using the bad address would just fail again. Customer confirms / updates.

### Step 6 — create_replacement

Build the replacement via `src/lib/replacement-order.ts`:

1. [[../integrations/shopify]] `draftOrderCreate` with the missing items + confirmed shipping address.
2. `draftOrderComplete` with payment_pending=false (no charge) — pushes to a fulfillable order.
3. Insert [[../tables/replacements]] row linking back to the original order.
4. Stamp the replacement order with `replacement: true` so it doesn't trigger our normal order-event flows (no marketing attribution, no LTV bump).
5. Track against `workspaces.replacement_threshold_cents` — if the customer's cumulative replacement value crosses the threshold, escalate to agent for manual approval next time.

### Step 7 — adjust_subscription

If the missing/damaged items came from a subscription order, the customer's NEXT renewal will pre-charge for items they already received via replacement. So we:

- Skip the next sub order, OR
- Remove the affected line items from the next ship only (one-time line-item modifier).

`src/lib/appstle.ts` handles the mutation. Defaults to "skip next order" — simpler, safer.

## No policy or exceptions

`exception_limit=0` and `stand_firm_max=0` — this playbook doesn't have a "we can't help you" path. If we own the issue (we shipped wrong items, the carrier lost the package), the replacement gets issued. The eligibility gate is BEFORE the playbook runs — via:

- The orchestrator's confirmed-fraud gate (see [[../lifecycles/fraud-detection]]).
- `workspaces.replacement_threshold_cents` over-threshold detection.

If either blocks, the orchestrator escalates without ever starting this playbook.

## No policy / no exceptions table

[[../tables/playbook_policies]] has 0 rows for this playbook. [[../tables/playbook_exceptions]] has 0 rows. The "policy" is implicit: shipped wrong / didn't arrive → fix.

## Allergy / safety reports → escalate, never auto-refund

A customer reporting an allergy or medical reaction is a **safety-critical anomaly, not a self-serve refund trigger**. The active `exchanges` policy (slug=`exchanges`, § *Allergy Override Priority* + the *Return-required matrix*) governs the behavior; the orchestrator reads it via `buildPoliciesSection` in `src/lib/sonnet-orchestrator-v2.ts`. Required behavior:

- **Acknowledge the safety concern warmly, every turn**, and `action_type='escalate'` for human safety review (`escalation_reason="allergy/safety report — needs immediate review"`). Aligns with `sonnet_prompts` #e0147885 ("tickets are anomalies — do NOT pre-commit a refund/replacement").
- **Never auto-issue a same-turn cash refund to the card**, and never close as resolved without a human review.
- **Replacement-chosen path** is unchanged: prepaid EasyPost return label + `refund_amount=0` (the replacement IS the refund).
- **Refund-chosen path** (the matrix gap this closed): no refund-to-card without a return. Any approved cash refund routes through the [[refund]] playbook — return required on a **fulfilled** order; **void/cancel** an UNFULFILLED (never-shipped) order instead of refunding-to-card.

`exchanges.rules`: `allergy_override_priority` carries `action:"escalate"`; `allergy_refund_requires_return:true`.

_Root cause: ticket 46471a76 (Myra Eppright, 2026-06) — "deathly ill" report. The orchestrator treated her unwanted, never-shipped June 20 renewal (SC133069, $64.91, unfulfilled) as an "allergy refund", fired a direct `partial_refund` to the card with no return, no refund-playbook, and no escalation, then told her twice "someone will be in touch" while never escalating. Fixed by amending the exchanges Allergy Override from "replacement OR refund same turn, no clarification" to escalate-for-safety-review. See [[../specs/allergy-safety-escalate-not-auto-refund]]._

## Replacement vs return

This playbook is for cases where we replace; the [[refund]] playbook is for cases where we refund. Different complaint shapes:

- "I never got my order" → replacement.
- "I don't want this order" → refund.
- "These items are damaged" → replacement.
- "I want my money back" → refund.

Sonnet classifies the intent during step 0 (clarify_issue) and if the intent is actually "refund" not "replace," the orchestrator switches playbooks via the action executor.

## $-bearing replacement variant (`dollar_replacement`)

Phase 3 of [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]] added a compound "ship a replacement AND move money" primitive that the compiler loop + AI direct actions consume. Two flavors, both routed through `commerce/replacement.issueDollarReplacement` in [[../libraries/commerce__replacement]]:

- **Refund flavor** — ship a replacement + refund `replacement_amount_cents` back on the original order. Used when the customer both needs the product AND is owed money back (e.g. shipping protection they paid for that didn't help, or a partial refund on a defective item that we're also replacing).
- **Upcharge flavor** — ship a replacement AND bill the customer via `commerce/subscription.subscriptionOrderNow`. Used for upgrades / paid add-ons rolled into a replacement.

### Atomicity (compensating rollback)

The two halves are NOT wrapped in a single Supabase transaction (Shopify + Braintree are external systems). Instead the flow is a record-first / compensate-on-failure pattern:

1. `issueReplacement` runs FIRST — inserts the `replacements` row + creates the Shopify draft-complete order. If this half fails, no money moves. Exit early.
2. The money half (`commerce/refund.issueRefund` for the refund flavor, `subscriptionOrderNow` for the upcharge flavor) runs SECOND.
3. If the money half fails, `rollbackReplacement` compensates by deleting the just-created `replacements` row. The delete is guarded on `workspace_id` (never cross-tenant) + `id` (exactly one row) + `status NOT IN ('shipped','delivered')` (never destroy a fulfilled row if a race put us there) + `.select('id')` (assert exactly one row transitioned).

The Shopify order itself cannot be "un-created" — the guarantee this pattern preserves is **no orphan `replacements` row survives a failed refund**. Downstream reconcilers that trust "every replacements row has matching money movement" get that from this compound.

### `order_refunds` mirror write (best-effort)

On a successful refund half, the SDK writes an `order_refunds` mirror row (`{ workspace_id, order_id, replacement_id, amount_cents, method, refund_id, reason }`) so the shared reconciliation lens can see both sides of the movement. The mirror table itself lands with the M1 spec ([[../specs/returns-refund-internal-aware-dispatcher]] § order_refunds mirror); until it does, this insert soft-fails with a warning — the refund itself already succeeded (money moved) so a mirror miss never triggers rollback.

### Example — refund flavor

```ts
import { issueDollarReplacement } from "@/lib/commerce/replacement";

const result = await issueDollarReplacement(workspaceId, {
  customerId,
  shopifyCustomerId,
  items: [{ variantId: "42614433513645", quantity: 1 }],
  shippingAddress: { address1: "123 Main St", city: "Austin", provinceCode: "TX", zip: "78701", countryCode: "US" },
  reason: "damaged_items",
  originalOrderNumber: "SC132201",
  ticketId,
  initiatedBy: "ai",
  refund: {
    orderId: originalOrderInternalUuid,
    amountCents: 1000, // $10 refund back on the original order
    reason: "Partial refund alongside replacement (damaged items)",
    source: "ai",
    eventProperties: { ticket_id: ticketId },
  },
});
// result.success === true → replacements row + refund + order_refunds mirror all landed
// result.success === false && result.rolledBack === true → refund failed, replacements row deleted
```

### Direct-action wire-up

The AI orchestrator emits action `type: "dollar_replacement"` — handled by `directActionHandlers.dollar_replacement` in [[../libraries/action-executor]]. Action shape: `{ variant_id, quantity, replacement_amount_cents, shopify_order_id | order_number, reason, address? }`. The handler resolves the customer's Shopify id + the original order's internal UUID + a shipping address (explicit → order-match → sub → recent order fallback chain), then delegates.

## Address fallback

If the order ingestion ran without addresses (rare — see [[../lifecycles/fraud-detection]] address fallback chain), this playbook can stall at step 5 without a confirmable address. The shipping-address journey would have nothing to compare against. The fallback: ask the customer outright, validate via EasyPost, save back.

## Files

| File | Purpose |
|---|---|
| `src/lib/playbook-executor.ts` | Step engine |
| `src/lib/replacement-order.ts` | Builds the replacement draft order |
| `src/lib/shopify-draft-orders.ts` | Shopify draftOrderCreate + draftOrderComplete |
| `src/lib/easypost-order-sync.ts` | Tracking lookup for step 2 |
| `src/lib/appstle.ts` | Sub adjustment for step 7 |
| `src/lib/customer-events.ts` | Event logging |
| `src/app/dashboard/settings/playbooks/page.tsx` | Settings UI |

## Related

[[../README]] · [[refund]] · [[../tables/playbooks]] · [[../tables/replacements]] · [[../tables/orders]] · [[../tables/subscriptions]] · [[../journeys/missing-items]] · [[../journeys/shipping-address]] · [[../lifecycles/return-pipeline]] · [[../lifecycles/fraud-detection]] · [[../integrations/shopify]] · [[../integrations/easypost]] · [[../integrations/appstle]]
