# inngest/meta-sync

Per-workspace Meta Page + Instagram sync — refreshes `meta_pages` and ad metadata.

**File:** `src/lib/inngest/meta-sync.ts`

## Functions

### `meta-sync-spend`
- **Trigger:** event `meta/sync-spend`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 2, key: "event.data.ad_account_id" }]`


### `meta-daily-sync`
- **Trigger:** cron `0 11 * * *`
- **Retries:** 1


## Downstream events sent

_None._

## Tables written

_None._

## Tables read (not written)

- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
