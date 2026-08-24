# inngest/amazon-sync

Pulls Amazon SP-API order + ASIN data; writes `amazon_*`, `daily_amazon_order_snapshots`.

**File:** `src/lib/inngest/amazon-sync.ts`

## Functions

### `amazon-sync-orders`
- **Trigger:** event `amazon/sync-orders`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.connection_id" }]`


### `amazon-sync-asins`
- **Trigger:** event `amazon/sync-asins`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.connection_id" }]`


### `amazon-daily-sync`
- **Trigger:** cron `0 10 * * *`
- **Retries:** 1
- Fans out one `amazon/sync-orders` event per active connection with **`days: 30`**.

## Sync-window invariant (why 30 days, day-aligned)

`processOrderReport` upserts **whole `(snapshot_date, order_bucket)` rows** — it
replaces a day's totals rather than accumulating into them. Two consequences that
are easy to get wrong, both of which caused a real revenue understatement:

1. **The window must outlast Amazon settlement, not just "late reporting."**
   A day that falls out of the rolling window is frozen FOREVER at whatever the
   last sync saw. Amazon keeps materializing orders well past the order date
   (SnS renewals, `Pending` → `Shipped`), so a short window permanently bakes in
   an undercount. The cron ran `days: 3` until 2026-08-24; measured against fresh
   SP-API reports that left **Jun–Aug understated by ~$18.1K of checkout revenue**
   (July alone −18%, Aug −16%). Forensic tell: every day's row was stamped exactly
   **+82h** after the day, then never touched again. → widened to `days: 30`.

2. **The window must be DAY-ALIGNED (UTC), never clock-relative.**
   `startDate` is snapped to `00:00Z` and `endDate` to tomorrow `00:00Z`. A
   `Date.now() - days*86400000` window hands the report a partial first day (only
   the slice after the current wall-clock time) and the upsert then clobbers that
   day's complete row with the partial one.

To repair historical days after a window change, re-run
`scripts/backfill-amazon-product-snapshots.ts --start <d> --end <d> --apply` — it
re-pulls the reports in chunks and re-asserts BOTH snapshot tables idempotently.

Consumers of the understated data: the ROAS dashboard
([[../../../src/app/api/workspaces/[id]/analytics/roas/route.ts]]) reads
`daily_amazon_order_snapshots` directly, so Amazon revenue, ROAS and the
AOV×churn LTV are all wrong whenever this window is too short.

## Downstream events sent

_None._

## Tables written

- [[../tables/amazon_asins]]
- [[../tables/daily_amazon_order_snapshots]] (aggregate, via `processOrderReport`)
- [[../tables/daily_amazon_product_snapshots]] (per-product layer, via `processOrderReport`)

## Tables read (not written)

- [[../tables/amazon_connections]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
