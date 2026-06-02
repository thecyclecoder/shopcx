# libraries/shopify-draft-orders

Draft order create + complete. Used by replacement-order playbook + storefront cart-bridge legacy path.

**File:** `src/lib/shopify-draft-orders.ts`

## File header

```
Shopify Draft Order creation for replacement orders
Creates $0 draft orders using 100% discount, then completes them
```

## Exports

### `createReplacementDraftOrder` — function

```ts
async function createReplacementDraftOrder(workspaceId: string, input: ReplacementOrderInput,) : Promise<CreatedDraftOrder>
```

### `completeDraftOrder` — function

```ts
async function completeDraftOrder(workspaceId: string, draftOrderId: string,) : Promise<CompletedReplacementOrder>
```

### `createAndCompleteReplacement` — function

```ts
async function createAndCompleteReplacement(workspaceId: string, input: ReplacementOrderInput,) : Promise<CompletedReplacementOrder>
```

### `ReplacementLineItem` — interface

### `ReplacementOrderInput` — interface

### `CreatedDraftOrder` — interface

### `CompletedReplacementOrder` — interface

## Callers

- `src/app/api/workspaces/[id]/replacements/[replacementId]/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
