# inngest/klaviyo-engagement-backfill

180d historical engagement events backfill. **Unreliable on Vercel** — prefer `scripts/backfill-engagement-local.ts`.

**File:** `src/lib/inngest/klaviyo-engagement-backfill.ts`

## Functions

### `klaviyo-engagement-backfill`
- **Trigger:** event `marketing/klaviyo-engagement.backfill`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/profile_events]]
- [[../tables/workspaces]]

## Tables read (not written)

- [[../tables/klaviyo_events]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
