# libraries/commerce__chargeback

Chargeback dispute operations in the Commerce SDK.

**File:** `src/lib/commerce/chargeback.ts`

**Status:** Phase 1 surface declared (Phase 1 complete). Implementations arrive in M2b/M2c per [[../reference/commerce-sdk-inventory.html]].

## Exports

**`export type { ChargebackView }`**
- Canonical chargeback view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Sub cancellations from `auto_action_taken='subscriptions_cancelled'` live in `chargeback_subscription_actions` keyed by `chargeback_event_id` — the Display op joins them so the view carries WHICH subs were cancelled, not just that SOMETHING was.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../tables/chargebacks]] — Chargeback table schema.
[[./types]] — Commerce SDK type definitions.
