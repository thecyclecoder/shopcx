# libraries/avalara-tax-codes

Tax code lookup per [[../tables/product_variants]]. Falls back to `workspaces.avalara_default_tax_code`.

**File:** `src/lib/avalara-tax-codes.ts`

## File header

```
Maps Shopify Standard Product Taxonomy category names → Avalara
AvaTax product codes.
Code reference (Avalara public taxonomy):
PF050144  Dietary supplements (Vitamins & Supplements branch)
PC040100  Food and food ingredients for human consumption — used
for unprepared coffee, creamer, K-cups, etc. Most US
states tax groceries at a reduced rate or exempt them.
P0000000  Tangible personal property — fully taxable generic
merchandise (mugs, tumblers, drink mixers).
OS010100  Shipping insurance / shipping protection. Many states
do not tax this; Avalara handles the jurisdictional
rules when this code is set.
Returning `null` means "let Avalara default-classify it" — we use
that for the workspace default (PF050144 in our seed) plus any
truly unclassifiable item (e.g. internal "Mystery Item" SKU).
Order of resolution at transaction time:
1. product_variants.shopify_tax_code (Shopify Plus / Avalara field)
2. products.avalara_tax_code (this classifier or manual override)
3. workspaces.avalara_default_tax_code
4. let Avalara guess from item description
```

## Exports

### `classifyByShopifyCategory` — function

```ts
function classifyByShopifyCategory(category: string | null | undefined, title: string | null | undefined = null) : AvalaraClassification
```

### `AvalaraClassification` — type

## Callers

- `src/app/api/workspaces/[id]/sync-products/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
