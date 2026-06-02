# inngest/today-sync

Today-only incremental Shopify sync (faster path than the full bulk op).

**File:** `src/lib/inngest/today-sync.ts`

## Functions

### `today-sync`
- **Trigger:** cron `*/5 * * * *`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

_None._

## Tables read (not written)

- [[../tables/amazon_connections]]
- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
