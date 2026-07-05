# libraries/commerce__customer

The **Display** half of the commerce SDK for customers — the entity-named read that hydrates one customer with a compact `customer_events` summary + `customer_demographics` snapshot in one call.

**File:** `src/lib/commerce/customer.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 3 · **Depends on:** [[../tables/customers]] · [[../tables/customer_events]] · [[../tables/customer_demographics]]

## Why this exists

Every customer-360 surface (ticket detail, dashboard customers page, AI stack) fans out to the same three reads today: the customer row, a rolled-up event count / last-event, and demographics. Consolidating that into one Display op keeps surfaces from re-writing the joins.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`getCustomer(workspaceId, customerId)`** → `CustomerView` — hydrates the customer row, a compact events summary (`total_events`, `last_event_type`, `last_event_at`) from [[../tables/customer_events]], and a demographics snapshot from [[../tables/customer_demographics]]. Throws when the customer is missing or not in the given workspace.

Type re-export: `CustomerView` (see [[commerce__types]] for `CustomerEventsSummaryView` and `CustomerDemographicsView`).

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__loyalty]] · [[commerce__chargeback]] · [[commerce__fraud]]
