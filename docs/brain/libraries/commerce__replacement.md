# libraries/commerce__replacement

The **Display** half of the commerce SDK for replacements — one read/list surface, cursor-paginated past PostgREST's 1000-row cap.

**File:** `src/lib/commerce/replacement.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 2 · **Depends on:** [[../tables/replacements]]

## Why this exists

A replacement is created from a source order and can adjust the linked subscription's next billing date — that side effect belongs on the Mutation op, not on any surface. The Display op just reads the replacement row and hydrates it to `ReplacementView`. See [[replacement-order]].

Cursor pagination on `(created_at DESC, id DESC)` walks past PostgREST's 1000-row cap per the goal's "no silent truncation" invariant.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`getReplacement(workspaceId, replacementId)`** → `ReplacementView` — one replacement fetched by internal UUID. Throws when missing or not in the given workspace.
- **`listReplacementsByCustomer(workspaceId, customerId)`** → `ReplacementView[]` — every replacement for one customer via direct `customer_id` match (link-follow is a caller concern).
- **`listReplacements(workspaceId, filters?)`** → `ReplacementView[]` — a workspace's replacements with optional `ReplacementListFilters` (`customer_id`, `status`, `page_size`, `max_rows`). Default `page_size = 500`, default `max_rows = ∞`.

Type re-export: `ReplacementView`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__order]]
