# qb_shopify_sales_snapshots

Per-variant, per-day Shopify sales — the Shopify sales-receipt driver (COGS) and the audit's Shopify burn term. Owner: [[../functions/cfo]] (Grace). Read by [[../libraries/qb-close-month-end]]. Mirrors Shoptics' `shopify_sales_snapshots` column-for-column plus `workspace_id`.

**Primary key:** `id` · **Unique:** `(workspace_id, variant_id, sale_date)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `variant_id` | `text` | NOT NULL · composite **`${product_id}-${variant_id}`**, NOT the bare sku — load-bearing, this is the `qb_sku_mappings.external_id` key for source `shopify` |
| `sku` / `product_name` | `text?` | descriptive only; never join on these |
| `sale_date` | `date` | NOT NULL · **store-local** date (`created_at.split('T')[0]`), never UTC-converted |
| `units_sold` | `int` | **EXCLUDES fully-refunded orders** — see below |
| `revenue` | `numeric` | gross of discounts (`price × quantity`); Shopify `discount_allocations` are ignored here and handled on the JE side |
| `recurring_units` / `recurring_revenue` | | `source_name == subscription_contract_checkout_one` |
| `first_sub_units` / `first_sub_revenue` | | tags contain `First Subscription` |
| `one_time_units` / `one_time_revenue` | | everything else |
| `refund_units` / `refund_amount` | | units + revenue on **fully**-refunded orders |
| `snapshot_taken_at` | `timestamptz` | when the row was captured |

`recurring + first_sub + one_time == units_sold` (verified July 2026: 3,306 + 363 + 211 = 3,880).

## Gotchas

- **⭐ Inventory burn and COGS must use `units_sold + refund_units`.** A refunded unit still shipped and is not guaranteed restockable (CEO 2026-08-11). `units_sold` alone understates burn, which inflates expected inventory and books the difference as phantom shrinkage. The sum equals Shopify's own `quantity_ordered` exactly (July: 3,880 + 11 = 3,891).
- **Partial refunds count as full sales.** The sync tests `financial_status === 'refunded'` exactly, so `partially_refunded` orders land wholly in `units_sold` with the refunded portion never deducted. Existing behavior — changing it moves historical numbers.
- **Refund columns go stale.** A row is written the night after the sale; an order refunded days later is never revisited. July recorded 11 refund units while the live pull showed 39. **Totals are unaffected** (`units_sold + refund_units` is stable), so sales/COGS are safe — but anything refund-facing must pull live.
- **Timezone.** `sale_date` is store-local from an offset-bearing `created_at`. The upstream fetch pads ±1 day in UTC and filters back down; converting to UTC first shifts evening orders a day and will not reconcile.
- Grain is variant-day, so **order counts are not derivable** — no order id is stored.

## Related

[[qb_amazon_sales_snapshots]] · [[qb_internal_sales_snapshots]] · [[qb_sku_mappings]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]]
