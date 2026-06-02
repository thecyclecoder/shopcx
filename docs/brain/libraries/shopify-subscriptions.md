# libraries/shopify-subscriptions

Shopify-native subscription draft workflow: `subscriptionContractUpdate` → `subscriptionDraftLineAdd/Remove/Update` → `subscriptionDraftCommit`. Distinct from Appstle path; used for shipping-address updates on subs.

**File:** `src/lib/shopify-subscriptions.ts`

## File header

```
Shopify subscription contract draft workflow for line item + date mutations
Flow: subscriptionContractUpdate → draft mutations → subscriptionDraftCommit
```

## Exports

### `addLineItem` — function

```ts
async function addLineItem(workspaceId: string, contractId: string, variantId: string, quantity: number,) : Promise<
```

### `removeLineItem` — function

```ts
async function removeLineItem(workspaceId: string, contractId: string, lineId: string,) : Promise<
```

### `updateLineItem` — function

```ts
async function updateLineItem(workspaceId: string, contractId: string, lineId: string, updates: { quantity?: number; variantId?: string },) : Promise<
```

### `changeNextBillingDate` — function

```ts
async function changeNextBillingDate(workspaceId: string, contractId: string, nextBillingDate: string,) : Promise<
```

### `getLineIdByVariant` — function

```ts
async function getLineIdByVariant(workspaceId: string, contractId: string, variantId: string,) : Promise<string | null>
```

## Callers

- `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
