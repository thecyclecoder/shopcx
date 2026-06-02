# inngest/klaviyo-engagement-sync

Daily 4am CST incremental engagement delta. Hard 1-day lookback, hardcoded metric_ids. Writes `profile_events`.

**File:** `src/lib/inngest/klaviyo-engagement-sync.ts`

## Functions

### `klaviyo-engagement-sync`
- **Trigger:** event `marketing/klaviyo-engagement.sync`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/klaviyo_profile_directory]]
- [[../tables/profile_events]]

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
