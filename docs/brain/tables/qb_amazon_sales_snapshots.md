# qb_amazon_sales_snapshots

Per-ASIN, per-day Amazon sales — drives the Amazon sales receipt (COGS) and the audit's Amazon burn term. Owner: [[../functions/cfo]] (Grace). Read by [[../libraries/qb-close-month-end]]. Mirrors Shoptics' `amazon_sales_snapshots` plus `workspace_id`.

**Primary key:** `id` · **Unique:** `(workspace_id, asin, sale_date)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `asin` | `text` | NOT NULL · the `qb_sku_mappings.external_id` key for source `amazon` |
| `seller_sku` | `text?` | the merchant SKU; the **two-hop** fallback key (see below) |
| `product_name` | `text?` | descriptive only |
| `sale_date` | `date` | NOT NULL |
| `units_shipped` | `int` | **the burn/COGS quantity** — shipped, not ordered |
| `revenue` | `numeric` | |
| `units_pending` / `units_cancelled` | `int` | not shipped; excluded from burn |
| `recurring_units` / `recurring_revenue` | | promotion string `FBA Subscribe & Save Discount` |
| `sns_checkout_units` / `sns_checkout_revenue` | | promotion string `Subscribe and Save Promotion V2` |
| `one_time_units` / `one_time_revenue` | | everything else |
| `snapshot_taken_at` | `timestamptz` | |

## Gotchas

- **Resolution is ASIN-first, then seller-SKU.** Some mappings are keyed by seller-SKU rather than ASIN. A seller_sku that is not itself a mapping key resolves via the **two-hop** `seller_sku → qb_external_skus.external_id (ASIN) → qb_sku_mappings → product` — so `qb_external_skus` is a silent dependency of Amazon resolution. See [[../libraries/qb-close-month-end]] and `qb-close/resolvers.ts`.
- **Multipliers matter.** Many Amazon ASINs are multi-packs; `qb_sku_mappings.unit_multiplier` converts listing units to physical units (July 2026: 12 of 29 active amazon mappings are ×2). Burn is `units_shipped × multiplier`.
- Amazon units are fulfilled from **FBA**, not the 3PL — so this table's burn draws down [[qb_amazon_inventory_snapshots]], not [[qb_tpl_inventory_snapshots]].
- Unlike [[qb_shopify_sales_snapshots]] there is no refund column here; Amazon returns surface separately and are not netted at this grain.

## Related

[[qb_shopify_sales_snapshots]] · [[qb_amazon_inventory_snapshots]] · [[qb_sku_mappings]] · [[../libraries/qb-close-month-end]]
