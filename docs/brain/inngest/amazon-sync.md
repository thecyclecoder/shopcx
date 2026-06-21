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
