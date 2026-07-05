# libraries/commerce__return

Return read and mutation operations in the Commerce SDK. Handles return lifecycle and refund issuance.

**File:** `src/lib/commerce/return.ts`

**Status:** Display operations shipped (Phase 2 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getReturn(workspaceId, returnId) → ReturnView`**
- Retrieves a single return with fully enriched view (items, order/label/net refund, resolution).
- Per [[../reference/commerce-sdk-inventory.html]], ReturnView includes items, order reference, shipping label, net refund amount, and resolution status.

**`listReturnsByCustomer(workspaceId, customerId, filters?) → ReturnView[]`**
- Lists all returns for a customer, paginated by cursor on `updated_at + id` per [[../README.md]] § Probing technique.
- Supports filtering by status and date range.

**`listRefundableReturns(workspaceId, filters?) → ReturnView[]`**
- Lists returns where `easypost_shipment_id IS NOT NULL` — only returns with proof of return can be refunded.
- Per [[../tables/returns]] § Gotchas, `net_refund_cents` is set at creation and MUST be trusted at refund time.

**`listReturns(workspaceId, filters?) → ReturnView[]`**
- Lists all returns in a workspace, paginated by cursor.
- Backed by Postgres RPC for performance.

### Types

**`export type { ReturnView, ReturnLineView }`**
- Canonical return and line item views, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Returns refund on EasyPost `delivered` (not carrier first-scan), and `net_refund_cents` is set at creation and MUST be trusted at refund time — the Mutation op enforces that invariant.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[./types]] — Commerce SDK type definitions.
