# libraries/commerce__order

Order read and mutation operations in the Commerce SDK. Unified surface for order reads, refunds, and shipping updates.

**File:** `src/lib/commerce/order.ts`

**Status:** Display operations shipped (Phase 2 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getOrder(workspaceId, orderId) → OrderView`**
- Retrieves a single order with fully enriched view (lines, totals, fulfillment, gateway, attribution).
- Per [[../reference/commerce-sdk-inventory.html]], OrderView includes lines, totals, fulfillment, gateway, and attribution fields.

**`listOrdersByCustomer(workspaceId, customerId, filters?) → OrderView[]`**
- Lists all orders for a customer, paginated by cursor on `updated_at + id` per [[../README.md]] § Probing technique.
- Handles >1000-row result sets without silent truncation.
- Returns fully enriched `OrderView` for each order.

**`listOrders(workspaceId, filters?) → OrderView[]`**
- Lists all orders in a workspace, paginated by cursor.
- Backed by Postgres RPC for performance (SQL/list ops match the 3h→8s precedent).
- Supports filtering by status, date range, and other order attributes.

### Types

**`export type { OrderView }`**
- Canonical order view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Order reads project the order + fulfillment + payment gateway state in one round trip via a Postgres RPC. This avoids the N+1 pattern of per-order fulfillment lookups. All money fields resolve through [[./pricing]] so totals never show $NaN or $0 unintentionally.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../tables/orders]] — Order table schema.
[[./types]] — Commerce SDK type definitions.
[[./pricing]] — Pricing enrichment applied to order totals.
