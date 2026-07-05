# libraries/subscription-items

**Status:** Deprecated for internal surfaces (M4 migrated dashboard + agent + AI to [[../libraries/commerce__subscription]]). Portal surfaces still use subscription-items; M5 will retire the portal shims.

Legacy Appstle line-item mutations: swap, add, remove, price update, quantity update. Wraps Appstle's subscription-contract-* endpoints. **Has 0.75 SubSave price multiplier baked into `subUpdateLineItemPrice`** — set the visible price; the multiplier shifts it to the post-SubSave price on the contract.

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
- `subUpdateLineItemPrice` is the **restore-the-grandfathered-base** step of subscription overcharge remediation ([[subscription-overcharge]]): it heals the Appstle sub in place (`healOnTouch` first) or sets `price_override_cents` for internal subs. The `update_line_item_price` direct action ([[action-executor]]) now **routes internal subs first** (before the Appstle config/lineId fetch, which would fail with "Appstle not configured" for an internal sub).
- `appstleRemoveLineItem` recognizes Appstle's **own last-item guardrail**: a `400` whose body matches `"must be present in a subscription"` / `"UserGeneratedError"` (Appstle refuses to remove the last recurring product). This is logged at `console.warn` (not `console.error`) and returned as `{ success: false, error: "would_remove_last_item" }` — the same friendly outcome [[portal__handlers__remove-line-item]]'s local pre-check produces. Without this, a stale-high local items snapshot would let the removal slip past the pre-check and Appstle's 400 would surface as a logged ERR + opaque 502 (Control Tower signature `vercel:0dda1c7b9495ebb1`). The handler maps `would_remove_last_item` straight to its friendly 400.

---

[[../README]] · [[../../CLAUDE]]
