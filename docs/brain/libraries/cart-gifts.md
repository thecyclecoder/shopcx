# libraries/cart-gifts

Free-gift logic for storefront cart.

**File:** `src/lib/cart-gifts.ts`

## File header

```
Free-gift injection.
Reads each product's pricing_rule.free_gift_* config, checks whether
the cart's quantity per product meets the threshold (and the
subscription gate is satisfied), and appends $0 gift lines. Used
by /api/cart on write AND by the checkout page on render so carts
created before the gift logic landed get the gift retroactively.
```

## Exports

### `ensureFreeGifts` — function

```ts
async function ensureFreeGifts(workspaceId: string, lines: CartLineLike[],) : Promise<CartLineLike[]>
```

### `CartLineLike` — interface

## Callers

- `src/app/(storefront)/checkout/page.tsx`
- `src/app/api/cart/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
