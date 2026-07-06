# libraries/commerce__chargeback

Chargeback dispute read and mutation operations in the Commerce SDK.

**File:** `src/lib/commerce/chargeback.ts`

**Status:** Display operations shipped (Phase 3 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`listChargebacksByCustomer(workspaceId, customerId, filters?) → ChargebackView[]`**
- Lists all chargebacks for a customer, paginated by cursor on `updated_at + id` per [[../README.md]] § Probing technique.
- Includes joined `chargeback_subscription_actions` so the view carries WHICH subs were cancelled, not just that SOMETHING was.
- Per [[../reference/commerce-sdk-inventory.html]], ChargebackView includes dispute, linked subs, and suggestions.

**`listChargebacks(workspaceId, filters?) → ChargebackView[]`**
- Lists all chargebacks in a workspace, paginated by cursor.
- Backed by Postgres RPC that joins the events + actions + dispute evidence in one round trip.
- Supports filtering by status, amount, and date range.

### Types

**`export type { ChargebackView }`**
- Canonical chargeback view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Sub cancellations from `auto_action_taken='subscriptions_cancelled'` live in `chargeback_subscription_actions` keyed by `chargeback_event_id` — the Display op joins them so the view carries WHICH subs were cancelled, not just that SOMETHING was.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../tables/chargebacks]] — Chargeback table schema.
[[./types]] — Commerce SDK type definitions.
