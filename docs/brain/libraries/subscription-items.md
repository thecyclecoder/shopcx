# libraries/subscription-items

Appstle line-item mutations: swap, add, remove, price update, quantity update. Wraps Appstle's subscription-contract-* endpoints. **Has 0.75 SubSave price multiplier baked into `subUpdateLineItemPrice`** — set the visible price; the multiplier shifts it to the post-SubSave price on the contract.

**File:** `src/lib/subscription-items.ts`

## File header

```
Unified subscription line item mutations via Appstle replaceVariants-v3
All subscription item changes (add, remove, swap, quantity) go through this single module.
```

## Exports

### `resolveVariantTitles` — function

```ts
async function resolveVariantTitles(workspaceId: string, variantIds: string[],) : Promise<Map<string,
```

### `enrichItemTitles` — function

```ts
async function enrichItemTitles(workspaceId: string, items: Record<string, unknown>[],) : Promise<Record<string, unknown>[]>
```

### `getAppstleConfig` — function

```ts
async function getAppstleConfig(workspaceId: string) : Promise<
```

### `resolveContractVariantId` — function

```ts
async function resolveContractVariantId(workspaceId: string, contractId: string, idOrTitle: string,) : Promise<
```

### `appstleRemoveLineItem` — function

```ts
async function appstleRemoveLineItem(workspaceId: string, contractId: string, variantOrLine: { variantId?: string; lineGid?: string },) : Promise<
```

### `subAddItem` — function

```ts
async function subAddItem(workspaceId: string, contractId: string, variantId: string, quantity: number = 1,) : Promise<
```

### `subRemoveItem` — function

```ts
async function subRemoveItem(workspaceId: string, contractId: string, variantOrLine: string | { variantId?: string; lineGid?: string },) : Promise<
```

### `subChangeQuantity` — function

```ts
async function subChangeQuantity(workspaceId: string, contractId: string, variantId: string, quantity: number,) : Promise<
```

### `subUpdateLineItemPrice` — function

```ts
async function subUpdateLineItemPrice(workspaceId: string, contractId: string, variantId: string, basePriceCents: number, lineGid?: string,) : Promise<
```

### `getLastOrderPrice` — function

```ts
async function getLastOrderPrice(workspaceId: string, customerId: string, sku: string | null, variantId: string | null,) : Promise<number | null>
```

### `calcBasePrice` — function

```ts
function calcBasePrice(targetPriceCents: number, discountPercent: number) : number
```

### `subSwapVariant` — function

```ts
async function subSwapVariant(workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string, quantity: number = 1,) : Promise<
```

## Callers

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/app/api/workspaces/[id]/crisis/[crisisId]/auto-swap/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/items/route.ts`
- `src/lib/portal/handlers/remove-line-item.ts`
- `src/lib/portal/handlers/replace-variants.ts`

## Gotchas

- `subUpdateLineItemPrice` has the 0.75 SubSave multiplier **baked in** — pass the visible MSRP, the helper applies × 0.75 before sending to Appstle. If you compute the SubSave price first, you'll end up at 0.5625 of MSRP.
- Every helper checks `isInternalSubscription()` first. Internal subs bypass Appstle.
- Variant ids must be Shopify variant ids when crossing into Appstle — internal UUIDs won't work.

---

[[../README]] · [[../../CLAUDE]]
