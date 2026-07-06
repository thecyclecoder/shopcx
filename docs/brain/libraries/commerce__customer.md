# libraries/commerce__customer

Customer 360 operations in the Commerce SDK. Unified surface for reading customer context, events, and financial state.

**File:** `src/lib/commerce/customer.ts`

**Status:** Display operations shipped (Phase 3 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getCustomer(workspaceId, customerId) → CustomerView`**
- Retrieves a complete customer 360 view in one call.
- Per [[../reference/commerce-sdk-inventory.html]], CustomerView is a batched view including subs, orders, returns, chargebacks, fraud, loyalty, payment, and credit.
- Hydrates `customer_events` summary, `customer_stats`, and demographics per [[../libraries/customer-stats]] and [[../libraries/customer-demographics]].

### Types

**`export type { CustomerView }`**
- Canonical customer 360 view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Customer 360 reads batch multiple queries into a single RPC to avoid N+1 lookups. The view carries the full customer context (subscriptions, order history, returns, disputes, fraud flags, loyalty balance, payment methods, store credit) that dashboard and ticket UIs need.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../tables/customers]] — Customer table schema.
[[../libraries/customer-stats]] — Customer statistics and behavioral aggregates.
[[../libraries/customer-demographics]] — Demographic enrichment.
[[./types]] — Commerce SDK type definitions.
