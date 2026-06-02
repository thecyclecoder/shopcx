# libraries/shopify-webhooks

Customer + order webhook handlers. Address fallback chain, customers/merge auto-link, orders/create → fraud detection trigger.

**File:** `src/lib/shopify-webhooks.ts`

## Exports

### `verifyShopifyWebhook` — function

```ts
async function verifyShopifyWebhook(body: string, hmacHeader: string, workspaceId: string) : Promise<boolean>
```

### `handleDisputeEvent` — function

```ts
async function handleDisputeEvent(workspaceId: string, payload: Record<string, unknown>, topic: string)
```

### `handleCustomerUpdate` — function

```ts
async function handleCustomerUpdate(workspaceId: string, payload: Record<string, unknown>)
```

### `handleOrderEvent` — function

```ts
async function handleOrderEvent(workspaceId: string, payload: Record<string, unknown>)
```

### `handleFulfillmentUpdate` — function

```ts
async function handleFulfillmentUpdate(workspaceId: string, payload: Record<string, unknown>)
```

## Callers

- `src/app/api/webhooks/shopify-returns/route.ts`
- `src/app/api/webhooks/shopify/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
