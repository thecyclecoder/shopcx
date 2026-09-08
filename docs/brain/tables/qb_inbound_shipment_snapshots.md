# qb_inbound_shipment_snapshots

The month-end close's **third physical bucket** — units shipped to Amazon but not yet received. Owner: [[../functions/cfo]] (Grace). Written daily by [[../libraries/qb-close-sync-sources]] `syncInboundShipmentsForClose` via [[../inngest/sync-qb-close-sources]]; read by [[../libraries/qb-close-month-end]].

> **Why a third bucket exists.** Period-end physical used to be FBA (`fulfillable + transit`) plus the 3PL's `quantity_on_hand`. A unit on an FBA replenishment is in **neither**: Amplifier has already decremented it, and `/fba/inventory/v1/summaries` reports nothing for it until Amazon starts receiving. It is real owned stock that both sources report as gone.

**Primary key:** `id` · **Unique:** `(workspace_id, snapshot_date, shipment_id, seller_sku)`

## The August 2026 case (why this table was built)

One consolidated shipment left Amplifier on **2026-08-15** and Amazon checked it in on **2026-09-01** — 17 days spanning the 08-31 cutoff. **1,050 units across 11 ASINs** were counted by nothing on the close date, so the audit booked them as shrinkage:

| | Before | After |
|---|---|---|
| Inventory adjustment | **$12,607.56** | **$5,064.54** |
| Absolute units | 7,000 | 2,540 |
| Superfood Tabs Mixed Berry 30ct | −725 ($5,085.15) | **−161** ($1,129.25) |
| Guard verdict | `adjustment_implausible` (band $7,129.98) | **passed** |

The signature was clean: **every** variance ≥ 100 units had a pre-cutoff 3PL drop plus a post-cutoff Amazon check-in; **every** variance < 100 had neither.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `snapshot_date` | `date` | NOT NULL · the day this position was observed |
| `shipment_id` | `text` | NOT NULL · Amazon `ShipmentId`, or `RECONSTRUCTED-*` for the one-time August backfill |
| `shipment_name` / `shipment_status` | `text?` | Amazon's own label + status at snapshot time |
| `seller_sku` | `text` | NOT NULL · inbound items report per seller SKU, not per ASIN |
| `asin` | `text?` | Resolved via the sellerSKU→ASIN map from the same FBA summaries crawl. **Null when unresolved — the close skips those lines rather than guessing** |
| `quantity_shipped` / `quantity_received` | `int4` | NOT NULL · default `0` |
| `in_transit` | `int4` | NOT NULL · `max(0, shipped − received)` |
| `snapshot_taken_at` / `created_at` | `timestamptz` | default `now()` |

## Gotchas

- **⭐ A dated in-transit position cannot be reconstructed later.** `shipped − received` collapses to zero once Amazon finishes receiving — by 2026-09-08 the two August shipments (`FBA19L2QSDBF`, `FBA19LT0NTKJ`) already read fully received. Same rule that forces the daily FBA/3PL snapshots: a missed day is permanently gone. This is why the sync is a daily cron, not something the close computes at run time.
- **`in_transit` is floored at zero.** Amazon can receive MORE than was declared shipped (August had a +21 over-receipt on `ST-DETOX-4`). A negative would silently subtract real stock from physical.
- **A failed lookup writes nothing, never a row of zeros.** `syncInboundShipmentsForClose` throws when `fetchOpenInboundShipments` reports `ok: false`. An absent snapshot is visibly absent; a zeroed one reads as "nothing in transit" and understates physical — the same distinction that cost $67,131 in July ([[../libraries/qb-close-guard]]).
- **`inTransitRows === 0` means MISSING, not empty**, for any month that shipped to FBA. [[../libraries/qb-close-guard]] raises a warning (not a blocker — a month that genuinely shipped nothing legitimately has no rows).
- **Unresolved seller SKUs are dropped, not guessed.** Amazon reports inbound per seller SKU and one ASIN spans several; the map comes from the same `/fba/inventory/v1/summaries` crawl. A SKU absent from that crawl yields `asin = null` and is excluded.
- **The August rows are a documented reconstruction, not a measurement.** `shipment_id = 'RECONSTRUCTED-2026-09-01-CHECKIN'`, written by `scripts/_backfill-aug-2026-in-transit.ts` from the arrival record: `in_transit(08-31) = max(0, (fulfillable+transit)@09-01 − @08-31)`. Using the delta of Amazon's *total* known position is what makes it safe from double-counting — anything Amazon already knew on 08-31 sits in both terms and cancels. Sales on 09-01 make it a slight under-estimate, which is the conservative direction.

## Related

[[qb_amazon_inventory_snapshots]] · [[qb_tpl_inventory_snapshots]] · [[../libraries/qb-close-sync-sources]] · [[../libraries/qb-close-month-end]] · [[../libraries/qb-close-guard]] · [[../inngest/sync-qb-close-sources]] · [[../functions/cfo]]
