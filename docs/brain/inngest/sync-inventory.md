# inngest/sync-inventory

Hourly Shopify inventory sync. **Dual-writes** the canonical [[../tables/inventory_levels]] (`location='shopify'`, keyed by variant id, via `writeInventory`) alongside the legacy `products.variants[].inventory_quantity` JSONB mirror + ratings/images. The JSONB write stays as a derived mirror until all readers migrate off it. Also fans product-level `servings` metafields down to `product_variants`.

**File:** `src/lib/inngest/sync-inventory.ts`

## Functions

### `sync-inventory`
- **Trigger:** cron `0 * * * *`
- **Retries:** 2


## Downstream events sent

_None._

## Tables written

- [[../tables/inventory_levels]] (canonical, `location='shopify'`) + `inventory_snapshots`
- [[../tables/products]] (JSONB mirror + rating/image)
- [[../tables/product_variants]] (servings fan-out)

## Tables read (not written)

- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
