# Change line item quantity

Update the qty for an existing line on a subscription.

## Helper

```ts
import { subChangeQuantity } from "@/lib/subscription-items";
```

**File:** `src/lib/subscription-items.ts` (line 362)

## Signature

```ts
async function subChangeQuantity(args: {
  workspaceId: string;
  contractId: string;
  shopifyVariantId: string;
  quantity: number;          // new absolute qty (not a delta)
}): Promise<{ success: boolean; error?: string }>
```

## Minimal example

```ts
await subChangeQuantity({
  workspaceId,
  contractId: subscription.shopify_contract_id,
  shopifyVariantId: variant.shopify_variant_id,
  quantity: 2,   // customer now wants 2 instead of 1
});
```

## Gotchas

- **Absolute qty, not delta.** Pass `2`, not `+1`.
- **Don't pass 0.** To remove a line, call `subRemoveItem()` instead — see [[../libraries/subscription-items]].
- **Per-unit price stays the same.** This doesn't recompute total or apply SubSave multiplier — it just changes the qty.
- **Cart total recalculation happens on the Appstle side** at next billing.

## Related

[[../libraries/subscription-items]] · [[change-line-item-price]] · [[swap-variant]]
