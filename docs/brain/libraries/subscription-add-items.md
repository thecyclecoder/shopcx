# libraries/subscription-add-items

Add line items to an existing subscription via Appstle. Used by crisis Tier 2 re-add and replacement-order playbook step 7.

**File:** `src/lib/subscription-add-items.ts`

## File header

```
Helpers for appending cart items to an existing internal
subscription. Used by the three-way checkout choice:
"add_to_sub"   → subscribe-mode cart items become RECURRING
items on the sub (every renewal); one-time
cart items (gifts) become ONE-TIME items
(ride next renewal then drop off).
"renewal_only" → ALL cart items become ONE-TIME items on the
sub. No charge today, no separate order.
One-time items live on `subscriptions.items[]` with
`one_time_next_renewal: true`. The renewal billing-tick reads
them like normal items, charges accordingly, then on successful
order creation removes them from the array.
Always bumps the sub's `updated_at` so the portal's tax quote
invalidates and re-quotes on next load.
```

## Exports

### `loadAndValidateSub` — function

```ts
async function loadAndValidateSub(workspaceId: string, subId: string, customerId: string,) : Promise<
```

### `appendCartItemsToSub` — function

```ts
async function appendCartItemsToSub(workspaceId: string, subId: string, customerId: string, cartLines: CartItemLike[], mode: SubAddMode,) : Promise<
```

### `SubAddMode` — type

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
