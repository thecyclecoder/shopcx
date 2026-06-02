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

## Replacement vs return

This playbook is for cases where we replace; the [[refund]] playbook is for cases where we refund. Different complaint shapes:

- "I never got my order" → replacement.
- "I don't want this order" → refund.
- "These items are damaged" → replacement.
- "I want my money back" → refund.

Sonnet classifies the intent during step 0 (clarify_issue) and if the intent is actually "refund" not "replace," the orchestrator switches playbooks via the action executor.

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
