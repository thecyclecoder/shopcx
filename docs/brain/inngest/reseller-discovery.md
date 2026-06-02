# inngest/reseller-discovery

Weekly Mon 6am CT cron: pulls competitor offers per ASIN from Amazon SP-API → scrapes seller storefronts → upserts `known_resellers`.

**File:** `src/lib/inngest/reseller-discovery.ts`

## Functions

### `reseller-discovery-manual`
- **Trigger:** event `resellers/discover.run`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspaceId" }]`


### `reseller-discovery-weekly`
- **Trigger:** cron `0 12 * * 1`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/dashboard_notifications]]

## Tables read (not written)

- [[../tables/amazon_connections]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
