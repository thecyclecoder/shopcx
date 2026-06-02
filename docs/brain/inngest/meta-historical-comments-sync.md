# inngest/meta-historical-comments-sync

Backfills `social_comments` from Meta Graph for historical posts/ads (per-page sync).

**File:** `src/lib/inngest/meta-historical-comments-sync.ts`

## Functions

### `meta-historical-comments-sync`
- **Trigger:** event `meta/historical-comments.sync`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/meta_ad_accounts]]

## Tables read (not written)

- [[../tables/meta_connections]]
- [[../tables/meta_pages]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
