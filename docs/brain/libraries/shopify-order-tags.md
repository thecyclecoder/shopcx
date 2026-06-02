# libraries/shopify-order-tags

`addOrderTags()` / `removeOrderTags()` via Shopify GraphQL `tagsAdd` / `tagsRemove`. Used by fraud detection to apply `suspicious` tag for fulfillment hold.

**File:** `src/lib/shopify-order-tags.ts`

## File header

```
Shopify GraphQL mutations for adding/removing order tags
Used by fraud detection to tag orders as "suspicious" and release on dismiss
```

## Exports

### `addOrderTags` — function

```ts
async function addOrderTags(workspaceId: string, orderId: string, tags: string[],) : Promise<
```

### `removeOrderTags` — function

```ts
async function removeOrderTags(workspaceId: string, orderId: string, tags: string[],) : Promise<
```

## Callers

- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts`
- `src/lib/fraud-detector.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
