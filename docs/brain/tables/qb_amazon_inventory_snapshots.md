# qb_amazon_inventory_snapshots

Daily FBA inventory per ASIN — the Amazon half of "physical on hand" in the month-end audit. Owner: [[../functions/cfo]] (Grace) / [[../functions/logistics]] (Marco). Read by [[../libraries/qb-close-month-end]]. Sourced from Amazon SP-API.

**Primary key:** `id` · **Unique:** `(workspace_id, asin, snapshot_date)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `asin` | `text` | NOT NULL · maps to a product via `qb_sku_mappings` source `amazon` |
| `seller_sku` / `fn_sku` | `text?` | |
| `quantity_fulfillable` | `int` | available to ship |
| `quantity_inbound` | `int` | `inboundShippedQuantity + inboundReceivingQuantity` |
| `quantity_reserved` | `int` | `reservedQuantity.totalReservedQuantity` — customer orders / FC transfer / FC processing |
| `quantity_transit` | `int` | **`inboundWorkingQuantity + quantity_inbound + quantity_reserved`** |
| `snapshot_date` | `date` | NOT NULL |

## ⭐ Physical = `fulfillable + transit`. Never add `reserved` or `inbound`.

`quantity_transit` is **defined as a superset** of both other buckets (Shoptics `sync-engine.ts:283-285`):

```js
const inbound    = inboundShippedQuantity + inboundReceivingQuantity;
const reserved   = reservedQuantity.totalReservedQuantity;
const transitQty = inboundWorkingQuantity + inbound + reserved;
```

Adding `reserved` on top double-counts it. Verified across **3,240 rows** (2026-06-01 → 08-11): `transit == inbound + reserved` in 3,234; the 6 exceptions (2026-06-19/20) resolve exactly to a stable per-ASIN `inboundWorking`; and there are **zero** rows where `transit < reserved`, which is the test that would falsify the identity.

## Gotchas

- The audit selects the latest snapshot **on or before** period end. Confirm it landed on the actual month end — `meta.fbaSnapshotDate` in [[../libraries/qb-close-month-end]].
- **A replenishment is invisible until Amazon registers it.** Stock picked at the 3PL appears in neither system until an inbound shipment exists at Amazon. In August 2026 the pipeline jumped 26 → 1,054 inbound on **2026-08-07**, the same day the 3PL decremented — so Amplifier and Amazon were in sync and there was *no* cross-cutoff gap. Do not assume one without checking the daily series on both sides.
- Multipliers apply: many ASINs are multi-packs (`qb_sku_mappings.unit_multiplier`), and the 3PL additionally holds `FBA-*` **case-pack** SKUs with multipliers up to ×36.

## Related

[[qb_tpl_inventory_snapshots]] · [[qb_amazon_sales_snapshots]] · [[qb_book_inventory_snapshots]] · [[../libraries/qb-close-month-end]]
