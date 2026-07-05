# libraries/commerce__chargeback

The **Display** half of the commerce SDK for chargebacks — one read/list surface, cursor-paginated past PostgREST's 1000-row cap.

**File:** `src/lib/commerce/chargeback.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 3 · **Depends on:** [[../tables/chargeback_events]] · [[../lifecycles/chargeback-pipeline]]

## Why this exists

Consolidates the historical `from("chargebacks"` reads (a mix of `chargeback_events` reads across dashboard, ticket detail, AI stack) behind one entity-named Display op. Reads always project the full `ChargebackView` shape so an upstream surface can render the dispute + linked action state without a second query.

Cursor pagination on `(created_at DESC, id DESC)` walks past PostgREST's 1000-row cap per the goal's "no silent truncation" invariant.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`listChargebacksByCustomer(workspaceId, customerId)`** → `ChargebackView[]` — every chargeback for one customer via direct `customer_id` match (link-follow is a caller concern).
- **`listChargebacks(workspaceId, filters?)`** → `ChargebackView[]` — a workspace's chargebacks with optional `ChargebackListFilters` (`customer_id`, `status`, `page_size`, `max_rows`). Default `page_size = 500`, default `max_rows = ∞`.

Type re-export: `ChargebackView`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__fraud]] · [[commerce__customer]]
