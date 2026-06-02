# libraries/shopify-returns

`createFullReturn()` (the single entry point for new returns), `closeReturn()`, `partialRefundByAmount()`, `issueStoreCredit()`. Stores `net_refund_cents` at creation; pipeline trusts it forever. See [[../lifecycles/return-pipeline]].

**File:** `src/lib/shopify-returns.ts`

## File header

```
Shopify Returns API — create returns, attach tracking, dispose items, process, close
```

## Exports

### `createShopifyReturn` — function

```ts
async function createShopifyReturn(workspaceId: string, params: CreateReturnParams,) : Promise<CreateReturnResult>
```

### `attachReturnTracking` — function

```ts
async function attachReturnTracking(workspaceId: string, params: AttachTrackingParams,) : Promise<
```

### `disposeReturnItems` — function

```ts
async function disposeReturnItems(workspaceId: string, params: DisposeParams,) : Promise<
```

### `processReturn` — function

```ts
async function processReturn(workspaceId: string, returnId: string,) : Promise<
```

### `closeReturn` — function

```ts
async function closeReturn(workspaceId: string, returnId: string,) : Promise<
```

### `getReturnableItems` — function

```ts
async function getReturnableItems(workspaceId: string, shopifyOrderGid: string,) : Promise<ReturnableItem[]>
```

### `createFullReturn` — function

```ts
async function createFullReturn(params: FullReturnParams) : Promise<FullReturnResult>
```

### `CreateReturnParams` — interface

### `CreateReturnResult` — interface

### `AttachTrackingParams` — interface

### `DisposeParams` — interface

### `ReturnableItem` — interface

### `FullReturnParams` — interface

### `FullReturnResult` — interface

### `Disposition` — type

## Callers

- `src/app/api/workspaces/[id]/returns/[returnId]/dispose/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/refund/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/route.ts`
- `src/app/api/workspaces/[id]/returns/create-label/route.ts`
- `src/app/api/workspaces/[id]/returns/route.ts`
- `src/lib/inngest/returns.ts`

## Gotchas

- Always go through `createFullReturn()` — never set `is_return: true` on EasyPost shipments directly (it swaps from/to addresses).
- `net_refund_cents` is set at creation and is the contract. Never re-derive at refund time.
- `freeLabel: true` = we eat the EasyPost cost; net_refund = order_total_cents.

---

[[../README]] · [[../../CLAUDE]]
