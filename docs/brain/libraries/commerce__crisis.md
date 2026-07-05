# libraries/commerce__crisis

The **Display** half of the commerce SDK for out-of-stock crises — one entity-named read that rolls up every crisis affecting a customer PLUS their per-crisis tier state.

**File:** `src/lib/commerce/crisis.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 3 · **Depends on:** [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../lifecycles/crisis-campaign]]

## Why this exists

A crisis is an event (`crisis_events`) + per-customer tier state (`crisis_customer_actions`). Surfaces that render a customer's active retention offers need BOTH — the Display op rolls them into one view so nothing re-joins.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`getCrisisContext(workspaceId, customerId)`** → `CrisisContextView` — every crisis affecting the customer with their per-crisis tier state. Reads `crisis_customer_actions` for the customer, then hydrates each linked `crisis_events` row with its action list.

Type re-exports: `CrisisView`, `CrisisCustomerActionView`, `CrisisContextView`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__customer]]
