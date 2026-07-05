# libraries/commerce__return

The **Display** half of the commerce SDK for returns — one read/list surface, cursor-paginated past PostgREST's 1000-row cap, with an explicit "we own the refund" gate.

**File:** `src/lib/commerce/return.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 2 · **Depends on:** [[../tables/returns]]

## Why this exists

Returns refund on EasyPost `delivered` (not carrier first-scan). Rows we own the refund for are those with `easypost_shipment_id NOT NULL` — see [[../tables/returns]] § Gotchas. The `refundableOnly` filter enforces that at the source so a caller can't accidentally refund an imported/external return.

Cursor pagination on `(created_at DESC, id DESC)` walks past PostgREST's 1000-row cap per the goal's "no silent truncation" invariant.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`getReturn(workspaceId, returnId)`** → `ReturnView` — one return fetched by internal UUID. Throws when the return is missing or not in the given workspace.
- **`listReturnsByCustomer(workspaceId, customerId, filters?)`** → `ReturnView[]` — every return for one customer via direct `customer_id` match, with optional `refundableOnly` / `status` filters.
- **`listRefundableReturns(workspaceId, filters?)`** → `ReturnView[]` — a workspace's returns with `easypost_shipment_id NOT NULL` — convenience wrapper for the refund pipeline surface.
- **`listReturns(workspaceId, filters?)`** → `ReturnView[]` — a workspace's returns with optional `ReturnListFilters` (`customer_id`, `status`, `refundableOnly`, `page_size`, `max_rows`). Default `page_size = 500`, default `max_rows = ∞`.

Type re-exports: `ReturnView`, `ReturnLineView`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__order]]
