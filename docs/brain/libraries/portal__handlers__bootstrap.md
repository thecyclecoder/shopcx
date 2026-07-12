# libraries/portal/handlers/bootstrap

Portal bootstrap — loads customer + workspace branding + journey enablement.

**File:** `src/lib/portal/handlers/bootstrap.ts`

## Exports

### `bootstrap` — const

```ts
const bootstrap: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- **Catalog filter runs the suppressed-variant set.** After loading the
  workspace's products, bootstrap drops any variant whose id appears in
  `workspaces.portal_config.suppressed_variant_ids` (via
  [[portal__mutation-guard]] `getSuppressedVariantIds`) BEFORE the
  `inventory_quantity > 0` filter — so a variant that is IN STOCK but pulled
  off the portal for a crisis availability lever (e.g. SL) never surfaces in
  the swap/add UI. Products that end up with zero visible variants drop out
  of the catalog entirely.

---

[[../README]] · [[../../CLAUDE]]
