# libraries/avalara-cart

Quote tax for [[../tables/cart_drafts]] at checkout.

**File:** `src/lib/avalara-cart.ts`

## File header

```
Cart → Avalara line-item bridge. Shared by the tax-quote endpoint
(commit=false) and the final checkout commit (commit=true). The
quote at order-review and the committed invoice MUST share the
same line shape and tax codes so the displayed tax equals the
charged tax (Avalara is deterministic for the same inputs).
Tax-code resolution per line:
1. product_variants.shopify_tax_code  (Shopify Plus / Avalara field)
2. products.avalara_tax_code          (our classifier or manual override)
3. workspaces.avalara_default_tax_code (the default at the call site)
4. omit — let Avalara guess from description
Variants with taxable=false are still sent as lines but with
tax_code OS010100 → which Avalara handles as exempt where the
jurisdiction rules apply. Cleanest is to flag them as exempt up
front. For our catalog only the "Two-Way Protection" SP variant
lands here today.
```

## Exports

### `buildAvalaraLines` — function

```ts
async function buildAvalaraLines({ admin, workspaceId, lines, shippingCents, shippingMethodLabel, protectionCents, protectionTitle, }: BuildLinesArgs) : Promise<AvalaraLineItem[]>
```

### `CartLineForTax` — interface

### `BuildLinesArgs` — interface

## Callers

- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/tax-quote/route.ts`
- `src/lib/avalara-subscription.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
