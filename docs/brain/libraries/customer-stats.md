# libraries/customer-stats

Helpers: `getCustomerSubscriptions()`, `getCustomerOrders()`, `getCustomerLTV()`. Expand linked accounts via `linkedIds()`.

**File:** `src/lib/customer-stats.ts`

## File header

```
Customer stats (LTV, total_orders, first/last order dates) computed live from
the orders table. We previously stored these as denormalized columns on the
customers row, but they kept drifting (Shopify webhooks with missing/zero
order_count would zero them out). Always read via this helper.
```

## Exports

### `getCustomerStats` — function

```ts
async function getCustomerStats(customerId: string) : Promise<CustomerStats>
```

### `getCustomerStatsBatch` — function

```ts
async function getCustomerStatsBatch(customerIds: string[]) : Promise<Map<string, CustomerStats>>
```

### `CustomerStats` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
