# qb-close/sync-sources.ts

Keeps the month-end close's `qb_*` source tables fed from **ShopCX's own integrations**, so a month can be closed without hand-porting data out of Shoptics. Owner: [[../functions/cfo]] (Grace). Driven daily by [[../inngest/sync-qb-close-sources]]; consumed by [[qb-close-month-end]].

## Exports

| Export | Writes | Source |
|---|---|---|
| `syncShopifySalesForClose` | [[../tables/qb_shopify_sales_snapshots]] | `public.orders` (Shopify-originated) |
| `syncInternalSalesForClose` | [[../tables/qb_internal_sales_snapshots]] | `public.orders` (ShopCX-native) |
| `syncFbaInventoryForClose` | [[../tables/qb_amazon_inventory_snapshots]] | Amazon SP-API `fetchFbaInventoryByAsin` |
| `syncTplInventoryForClose` | [[../tables/qb_tpl_inventory_snapshots]] | Amplifier `fetchAmplifierInventory` |
| `storeLocalDate(utcIso, tz)` | — | UTC → store-local calendar date |

All idempotent (upsert on the natural key), safe to re-run for a range, read-only upstream.

## ⭐ Reads the RAW integrations, not `public.inventory_snapshots`

That table is a **lossy logistics view** and using it would silently reintroduce the two bugs that made July's first dry run report $85,864:

- it **drops FBA `reserved` entirely** (the column doesn't exist), so `transit` can't be derived
- for the 3PL it stores Amplifier's **`quantity_available` in a column named `on_hand`** (`sync-3pl-inventory.ts:28`), which excludes committed stock

The close needs `quantity_on_hand` (= available + committed) and `reserved`. So these syncs go to the APIs directly.

## Amazon SALES lives in its own module

`qb_amazon_sales_snapshots` is fed by [[qb-close-sync-amazon-sales]], not from here, because it needs its own SP-API report pull with the close's shipped-only rule. ShopCX's `daily_amazon_product_snapshots` counts Pending too (July: 803 ordered vs **597 shipped**, with 198 pending and 37 cancelled), so it can never substitute.

## ⭐ Store-local date bucketing

Shoptics buckets a sale to the local date in Shopify's offset-bearing `created_at`; ShopCX stores `created_at` in **UTC**. Bucketing by the UTC date shifts evening orders a day and will not reconcile — it is the whole of the 3-unit / 1-order gap between ShopCX's order table and Shopify's own July report. `storeLocalDate` converts via `Intl.DateTimeFormat` (`America/Chicago` for Superfoods, from `daily_order_snapshots.store_timezone`), and the order fetch pads ±1 UTC day then filters back down.

**Verified:** July 2026 buckets to exactly **3,891 gross units across 31 days** — matching Shopify's own Sales-by-SKU report to the unit.

## Resolution rules that cost real money

- **Shopify lines missing `product_id`.** The accounting key is the composite `${product_id}-${variant_id}`, but 268 of July's lines (382 units) carried only `variant_id`. They are resolved via `product_variants → products.shopify_product_id`, never skipped — skipping cost 129 units against ground truth.
- **Internal renewal lines.** `storefront` orders carry `sku`; `internal_subscription_renewal` orders carry none, and their `variant_id` is sometimes the internal UUID and sometimes the **Shopify** variant id. Resolution tries sku → `product_variants.id` → `product_variants.shopify_variant_id`.
- **An unresolvable internal line is still EMITTED** with a null product. Dropping it breaks the JE's `order_total == gross − discount + tax + shipping` identity by exactly its value — which is how one $48.27 line unbalanced the entire July journal entry.

## Verified against ground truth

| Sync | Result |
|---|---|
| Shopify sales | 481 rows · **3,891 gross units / 31 days** — exact match to Shopify's report |
| Internal sales | 66 orders · **$5,910.19** · JE identity holds exactly |
| FBA inventory | 45 ASINs · `transit == inbound + reserved` ✓ |
| 3PL inventory | 277 SKUs · on_hand 112,928 = available 112,364 + committed 564 ✓ |

`units_sold 3,852 / refund 39` vs Shoptics' `3,880 / 11` is the documented **stale-refund** effect — refunds landing after Shoptics snapshotted. Gross is identical, and gross is what burn and COGS use.

## Related

[[qb-close-month-end]] · [[../inngest/sync-qb-close-sources]] · [[../lifecycles/shoptics-migration]]
