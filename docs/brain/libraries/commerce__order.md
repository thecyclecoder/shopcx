# libraries/commerce__order

The **Display** half of the commerce SDK for orders — one read/list surface, cursor-paginated past PostgREST's 1000-row cap.

**File:** `src/lib/commerce/order.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 2 · **Depends on:** [[../tables/orders]]

## Why this exists

Orders are historical records — pricing is snapshotted at renewal time onto `orders.line_items`, so the Display op reads them as-is and does NOT re-price through [[commerce__price]] `priceSubscription`. The "no silent truncation" invariant ([[../specs/spec-goal-branch-pm-flow]]) is enforced by cursor-paginating on `(created_at DESC, id DESC)` past the 1000-row PostgREST cap.

Ships with zero call-site consumers — the M3 harness compares SDK output to the current dashboard / portal / AI hydration paths before any surface migrates.

## Exports

- **`getOrder(workspaceId, orderId)`** → `OrderView` — one order fetched by internal UUID. Throws when the order is missing or not in the given workspace.
- **`listOrdersByCustomer(workspaceId, customerId)`** → `OrderView[]` — every order for one customer via direct `customer_id` match (link-follow is a caller concern), cursor-paginated the same way as `listOrders`.
- **`listOrders(workspaceId, filters?)`** → `OrderView[]` — a workspace's orders with optional `OrderListFilters` (`customer_id`, `subscription_id`, `financial_status`, `fulfillment_status`, `order_type`, `page_size`, `max_rows`). Walks the cursor until fewer rows than `page_size` come back or `max_rows` caps it. Default `page_size = 500`, default `max_rows = ∞`.

Type re-exports: `OrderView`, `OrderLineView`.

## Verification

The Phase 2 verification probe is `scripts/_probe-commerce-display-orders.ts`. Two checks:

- **Row count parity.** Picks the customer with the most orders in the largest workspace (or `--customer=<uuid>` / `--workspace=<uuid>` overrides), runs `listOrdersByCustomer`, asserts the returned count matches `SELECT COUNT(*) FROM orders WHERE customer_id = $1`.
- **`refundableOnly` filter.** Runs `listReturnsByCustomer(refundableOnly:true)` and asserts every returned row has `easypost_shipment_id NOT NULL` (see [[commerce__return]]).

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__price]] · [[commerce__subscription]]
