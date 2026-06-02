# libraries/shopify-sync

Bulk operations + GraphQL helper + paginated sync. `fetchWithRetry` retries 429 + 5xx. `cancelBulkOperation()` clears stuck ops. Drives [[../inngest/sync-shopify]] + [[../inngest/today-sync]].

**File:** `src/lib/shopify-sync.ts`

## Exports

### `getShopifyCredentials` — function

```ts
async function getShopifyCredentials(workspaceId: string) : Promise<ShopifyCredentials>
```

### `getShopifyCounts` — function

```ts
async function getShopifyCounts(workspaceId: string) : Promise<
```

### `cancelBulkOperation` — function

```ts
async function cancelBulkOperation(workspaceId: string) : Promise<void>
```

### `startBulkOperationWithQuery` — function

```ts
async function startBulkOperationWithQuery(workspaceId: string, type: "customers" | "orders", startDate: string, endDate: string,) : Promise<string>
```

### `startBulkOperation` — function

```ts
async function startBulkOperation(workspaceId: string, mutation: string) : Promise<string>
```

### `pollBulkOperation` — function

```ts
async function pollBulkOperation(workspaceId: string) : Promise<
```

### `downloadBulkOrderUrl` — function

```ts
async function downloadBulkOrderUrl(workspaceId: string) : Promise<string>
```

### `upsertOrderChunk` — function

```ts
async function upsertOrderChunk(workspaceId: string, url: string, chunkIndex: number,) : Promise<
```

### `downloadAndUpsertCustomers` — function

```ts
async function downloadAndUpsertCustomers(workspaceId: string) : Promise<number>
```

### `downloadAndUpsertOrders` — function

```ts
async function downloadAndUpsertOrders(workspaceId: string) : Promise<number>
```

### `downloadBulkCustomerUrl` — function

```ts
async function downloadBulkCustomerUrl(workspaceId: string) : Promise<string>
```

### `upsertCustomerChunk` — function

```ts
async function upsertCustomerChunk(workspaceId: string, url: string, chunkIndex: number,) : Promise<
```

### `syncCustomerPages` — function

```ts
async function syncCustomerPages(workspaceId: string, cursor: string | null,) : Promise<SyncPageResult>
```

### `syncOrderPages` — function

```ts
async function syncOrderPages(workspaceId: string, cursor: string | null, // cursor here is the full next URL or null for first page) : Promise<SyncPageResult>
```

### `finalizeSyncOrderDates` — function

```ts
async function finalizeSyncOrderDates(workspaceId: string) : Promise<void>
```

### `syncCustomerBatch` — function

```ts
async function syncCustomerBatch(workspaceId: string, cursor: string | null,) : Promise<
```

### `preloadCustomerMaps` — function

```ts
async function preloadCustomerMaps(workspaceId: string) : Promise<
```

### `syncOrderBatch` — function

```ts
async function syncOrderBatch(workspaceId: string, cursor: string | null,) : Promise<
```

### `syncCustomerMonth` — function

```ts
async function syncCustomerMonth(workspaceId: string, startDate: string, endDate: string,) : Promise<number>
```

### `syncOrderMonth` — function

```ts
async function syncOrderMonth(workspaceId: string, startDate: string, endDate: string,) : Promise<number>
```

## Callers

- `src/app/api/customers/[id]/enrich/route.ts`
- `src/app/api/loyalty/redeem/route.ts`
- `src/app/api/workspaces/[id]/coupons/route.ts`
- `src/app/api/workspaces/[id]/crisis/[crisisId]/coupon-lookup/route.ts`
- `src/app/api/workspaces/[id]/crisis/coupon-lookup/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/approve/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/decline/route.ts`
- `src/app/api/workspaces/[id]/sync-products/route.ts`
- `src/app/api/workspaces/[id]/widget-install/route.ts`
- `src/lib/dunning.ts`
- `src/lib/inngest/order-address-fallback.ts`
- `src/lib/inngest/sync-inventory.ts`
- `src/lib/inngest/sync-shopify.ts`
- `src/lib/marketing-coupons.ts`
- `src/lib/portal/handlers/loyalty-apply-subscription.ts`
- `src/lib/portal/handlers/loyalty-redeem.ts`
- `src/lib/replacement-order.ts`
- `src/lib/research/probes/loyalty.ts`
- `src/lib/shopify-draft-orders.ts`
- `src/lib/shopify-marketing.ts`
- … and 6 more

## Gotchas

- Bulk operations are 1-at-a-time per shop — a stuck poll requires `cancelBulkOperation()` before restarting.
- GraphQL ids are GIDs (`gid://shopify/Customer/123`) — use `extractShopifyId()` for the numeric id.

---

[[../README]] · [[../../CLAUDE]]
