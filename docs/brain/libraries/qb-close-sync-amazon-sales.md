# qb-close/sync-amazon-sales.ts

Amazon **shipped** units per ASIN per day into [[../tables/qb_amazon_sales_snapshots]] — the Amazon sales-receipt (COGS) driver and the audit's Amazon burn term. Owner: [[../functions/cfo]] (Grace). Driven by [[../inngest/sync-qb-close-sources]].

## ⭐ Why this exists separately from `amazon/sync-orders.ts`

`units_shipped` ≠ units ordered, and the gap is large.

ShopCX's analytics parser ([[amazon-sync-orders]] → `daily_amazon_product_snapshots`) counts **Shipped + Shipping + Pending**, bucketed by purchase date, because it answers a *demand* question. The close answers an **inventory** question: only units that actually left a warehouse may burn stock and carry COGS.

Measured for 2026-07:

```
shipped                    597
pending                    198
cancelled                   37
shipped + pending          795
ShopCX analytics table     803   ← what a naive substitution would have used
```

Wiring the analytics table into the close would have overstated Amazon burn and COGS by ~35%. So this module re-parses the same SP-API report (`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`) with the close's own rule: `order-status ∈ {Shipped, Shipping}`, excluding Pending and Cancelled. Excluded units are **counted and reported**, never silently dropped.

## Exports

| Export | Purpose |
|---|---|
| `syncAmazonSalesForClose(admin, ws, start, end)` | request → poll → download → parse → upsert |
| `parseShippedUnits(tsv)` | the parser, exported for testing — the shipped/pending split is the whole point |

Idempotent: upserts on `(workspace_id, asin, sale_date)`.

## ⭐ Never `.trim()` a TSV line before splitting

```js
const line = lines[i].trim();   // WRONG
```

A row whose first or last column is empty — an absent order id, no promotion ids — begins or ends with a **TAB**, and `trim()` strips it, shifting every column left by one. That reads `item-price` as `quantity` and garbage as `order-status`. Real reports have empty columns constantly.

Strip only a trailing CR and test blankness on a copy:

```js
const raw = lines[i].replace(/\r$/, "");
if (!raw.trim()) continue;
const c = raw.split("\t");
```

Caught by `sync-amazon-sales.test.ts` before this ever ran on real data.

## Promotion bucketing

`FBA Subscribe & Save Discount` → `recurring` · `Subscribe and Save Promotion V2` → `sns_checkout` · else `one_time`. Amazon writes **`&`** in report data while docs show "and", so both spellings are matched — miss that and subscription revenue silently lands in `one_time`. Buckets sum to `units_shipped` by construction.

## Gotchas

- SP-API report generation is **asynchronous**: request → poll → download, with a 3-minute ceiling. A `CANCELLED`/`FATAL` status throws rather than returning empty.
- One ASIN can span several seller SKUs; rows merge per `(asin, sale_date)` and `seller_sku` keeps the first seen (descriptive only — never join on it).
- Multiple `amazon_connections` per workspace are merged.
- The report is bucketed by **purchase-date**, matching the proven implementation — so a unit ordered on the 31st and shipped on the 1st counts to the month it was ordered, provided its status has advanced by the time the report is pulled.

## Tests

`src/lib/qb-close/sync-amazon-sales.test.ts` — 6 cases. Run: `npx tsx --test src/lib/qb-close/sync-amazon-sales.test.ts`.

## Related

[[qb-close-sync-sources]] · [[qb-close-month-end]] · [[../tables/qb_amazon_sales_snapshots]] · [[../inngest/sync-qb-close-sources]]
