# qb_internal_sales_snapshots

Per-order-line record of **ShopCX-native** orders — storefront, native subscription renewals, comps — that fulfil through Amplifier (3PL) but never touched Shopify or Amazon. Drives the internal sales receipt (COGS), the audit's internal burn, and the JE's internal self-balancing block. Owner: [[../functions/cfo]] (Grace). Read by [[../libraries/qb-close-month-end]].

**Primary key:** `id` · **Unique:** `(order_id, line_index)` — the upsert key, so re-syncs converge.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `order_id` | `uuid` | NOT NULL · → [[orders]].id · CASCADE |
| `order_number` | `text?` | e.g. `SHOPCX139` |
| `line_index` | `int` | 0-based **over emitted rows**, not over source line items |
| `sale_date` | `date` | NOT NULL · bucketed from `orders.created_at` (UTC date) |
| `source_name` | `text?` | `storefront` · `internal_subscription_renewal` · … |
| `financial_status` / `processor` | `text?` | processor is the payment gateway (`braintree`, `comp`, …) |
| `sku` / `variant_id` | `text?` | resolution inputs |
| `product_id` | `uuid?` | → [[qb_items]].id · resolved via `qb_sku_mappings` source `3pl` |
| `units` | `numeric` | quantity × `unit_multiplier` |
| `gross_cents` | `int` | **per line** — `price_cents × quantity` |
| `order_total_cents`, `discount_cents`, `tax_cents`, `shipping_cents` | `int` | **order-level — carried ONLY on `line_index = 0`**, zero elsewhere, so an order is counted once |
| `raw_payload` | `jsonb?` | source `payment_details` etc. |

## ⭐ The JE balance identity

```
order_total_cents  ==  Σ gross_cents  −  discount_cents  +  tax_cents  +  shipping_cents
```

Per order. **If any line is dropped, `gross` falls but `order_total` does not, and the journal entry goes out of balance by exactly the dropped amount** — which QuickBooks rejects (tolerance $0.01). This is not theoretical: order `SHOPCX139` lost a $48.27 line and unbalanced the entire July 2026 JE by $48.27.

`shipping_cents` = shipping **plus** shipping protection.

## Gotchas

- **⭐ ShopCX renewal orders write inconsistent line items.** `storefront` orders carry `sku` + `product_id` + internal `variant_id`. `internal_subscription_renewal` orders carry **no `sku`**, and their `variant_id` is sometimes the internal UUID (`product_variants.id`) and sometimes the **Shopify** variant id (`product_variants.shopify_variant_id`). Resolution must try sku → internal UUID → shopify variant id. Keying on sku alone silently dropped 11 July orders ($968.55); adding only the internal-UUID fallback still missed one ($48.27).
- **A line that cannot be resolved must be TRACKED, never skipped.** Silently dropping it removes real revenue and unit burn from the close with nothing to alert on.
- Comp orders appear with `processor = 'comp'` and $0 totals — legitimate, they still burn inventory.
- Grain is per line, so summing `order_total_cents` across all rows is only correct because non-zero values exist on `line_index = 0` alone.

## Related

[[orders]] · [[qb_items]] · [[qb_sku_mappings]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]]
