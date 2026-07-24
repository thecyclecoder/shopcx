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

### `RecoverableShopifyReturnError` — class

Thrown by `createShopifyReturn` when the Shopify-side mirror comes back null (no returnable lines / Shopify rejected the return) or with userErrors. `createFullReturn` catches this class and returns `{ success: false, error }` WITHOUT `console.error` so a healthy recovery doesn't churn the Control Tower error feed.

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
- `createShopifyReturn` throws `RecoverableShopifyReturnError` for caller-handled failures (null Shopify mirror, Shopify userErrors). `createFullReturn` catches that class and returns `{ success: false, error }` WITHOUT `console.error` so a healthy recovery doesn't churn the Control Tower error feed (signature `vercel:314ca8c785aff3eb`). Unexpected throws still log.
- `closeReturn` splits two cases: if the return row is missing (`!ret`), it returns `{ success: false }` (genuine failure); if the row exists but `shopify_return_gid` is null (internal-order path), it returns `{ success: true }` immediately without calling Shopify — documented no-op since `createFullReturn` never creates a Shopify RETURN for internal orders. The Inngest caller in `returns-issue-refund` tolerates both outcomes via console.error; this reduces log noise for the internal-path case.

---

[[../README]] · [[../../CLAUDE]]
