# qb-close/month-end.ts

Assembles a month's close inputs from **ShopCX's own `qb_*` source tables** and drives the four ported builders in **shadow** — computes the 5 QBO artifacts, posts nothing. Owner: [[../functions/cfo]] (Grace). Part of [[../lifecycles/shoptics-migration]] Phase 1 (cutover).

> **Why this file exists.** The June 1:1 reconciliation ([[../lifecycles/shoptics-migration]] Phase 3) ran entirely off `fixtures/shoptics-golden/*.json` dumped out of the **Shoptics** DB. It proved the *engine*, never that ShopCX holds the data — and it kept passing after the fact even though seven of the source tables did not exist in ShopCX at all. This module is the piece that reads ShopCX.

## Export

```ts
buildMonthEndArtifacts(opts: BuildMonthEndOptions): Promise<MonthEndArtifacts>
```

| Option | Meaning |
|---|---|
| `workspaceId` | tenancy scope; every read is `.eq('workspace_id', ws)` |
| `month` | `'YYYY-MM'` |
| `admin` | `createAdminClient()` (service role) |
| `orders` | live Shopify orders for the month — the JE's revenue/tax/shipping/discount basis |
| `receivedByProduct` | `qb_items.id` → units received via QB Bill/Purchase in the period |

Returns `{ month, journalEntry, receipts{amazon,shopify,internal}, inventoryAdjustment, meta }`. `meta` carries the opening-book row count and the FBA/3PL snapshot dates actually used — read these, a silently-empty basis is the difference between a $2K and an $86K adjustment.

## The three source-column invariants (each cost a real incident)

These live here rather than in the builders because they are decisions about **which column is physical truth**, not about arithmetic. All three were proven against the July 2026 close.

1. **Shopify burn = `units_sold + refund_units`.** `units_sold` excludes fully-refunded orders (the sync buckets those into `refund_units`). A refunded unit still *shipped* and is not guaranteed restockable, so it must burn inventory and carry COGS. CEO directive 2026-08-11. Cross-check: `units_sold + refund_units` equals Shopify's own `quantity_ordered` exactly (July: 3,880 + 11 = 3,891).
2. **3PL physical = `quantity_on_hand`, NOT `quantity_available`.** `available` nets off units **committed** to orders the 3PL has not yet shipped — still on the shelf, still ours at the cutoff. Reading `available` booked owned stock as shrinkage; in July the excluded bucket swung 1,053 → 2,754 units and turned the whole coffee/creamer range negative.
3. **FBA physical = `fulfillable + transit` ONLY.** `quantity_transit` is *defined* as `inboundWorking + quantity_inbound + quantity_reserved` (Shoptics `sync-engine.ts:283-285`). Adding `reserved` or `inbound` on top double-counts. Verified across 3,240 rows (2026-06-01 → 08-11): `transit == inbound + reserved` in 3,234, the 6 exceptions resolving exactly to `inboundWorking`, and **zero** rows where `transit < reserved`.

## Reading pattern

Every read pages via `.range(from, from+999)`. **PostgREST silently caps at 1000 rows regardless of `?limit` or a `Range` header** — no error, just short totals. This truncation produced two wrong conclusions during the July dry run before it was caught (an under-reported FBA/3PL day-coverage, and a fabricated per-ASIN transit delta).

## Inputs → tables

| Input | Table |
|---|---|
| item catalog / BOM / mappings | [[../tables/qb_items]] · [[../tables/qb_item_bom]] · [[../tables/qb_sku_mappings]] |
| accounts / gateways / shipping-protection | `qb_account_mappings` · `qb_gateway_mappings` · `qb_shipping_protection_products` |
| sales | [[../tables/qb_amazon_sales_snapshots]] · [[../tables/qb_shopify_sales_snapshots]] · [[../tables/qb_internal_sales_snapshots]] |
| physical inventory | [[../tables/qb_amazon_inventory_snapshots]] · [[../tables/qb_tpl_inventory_snapshots]] · `qb_manual_inventory` |
| opening book | [[../tables/qb_book_inventory_snapshots]] — prior month's `month_end_post` |
| processor rollups | [[../tables/qb_payment_processor_summaries]] |

## Gotchas

- **Opening book is the prior month's `month_end_post`.** Missing it does not error — `qbInventory` is simply empty and every item reads as a total loss. `meta.qbBasisRows` is the tell (July 2026 expects 86).
- **`qb_manual_inventory` has no history.** Values are CURRENT, so a mid-month edit retroactively changes a closed month's audit. The July close was distorted by a `10,725` VitaQuest raw-carton row never drawn down after those cartons became finished goods.
- **`receivedByProduct` empty ≠ nothing received.** Shoptics' equivalent lookup sits behind a bare `catch {}` that degrades to 0; that is exactly how a real 9,652-unit receipt went missing and produced a $67K phantom gain. Pass this explicitly and assert it.
- **Shopify orders older than ~60 days are unreachable** without the `read_all_orders` scope — the token holds plain `read_orders`. A close run more than 60 days after month start silently under-reports revenue *and still balances*. See [[../lifecycles/shoptics-migration]].

## Callers

`scripts/_shopcx-close-dryrun.ts` (shadow close + diff vs Shoptics' posted golden) · `scripts/_diff-shopcx-vs-shoptics.ts` (engine-vs-engine, both corrected — bridges on `quickbooks_id`, never on `quickbooks_name`, which collapses distinct same-named items).

## Related

[[../lifecycles/shoptics-migration]] · [[quickbooks]] · [[../functions/cfo]] · [[../tables/qb_month_end_closings]]
