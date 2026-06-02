# inngest/klaviyo-events-import

Pulls Klaviyo Placed Order events with UTM-attribution parsing. Writes `klaviyo_events`.

**File:** `src/lib/inngest/klaviyo-events-import.ts`

## Functions

### `klaviyo-events-import`
- **Trigger:** event `marketing/klaviyo-events.import`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/klaviyo_events]]

## Tables read (not written)

- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
