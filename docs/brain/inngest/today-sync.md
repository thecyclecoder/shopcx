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

## Per-account Meta error handling

The Meta loop wraps each account in a try/catch and continues to the next
account on failure. The log level is split so the Control Tower error feed only
escalates real problems:

- `metaSubcode === 1504018` ("Your request timed out") → `console.warn`. Known
  Meta-side backend blip; the next 5-min cron run retries successfully, so this
  is self-healing and must not surface as an open bug. See [[../specs/today-sync-quiet-handled-meta-timeout-blips]].
- Everything else (auth 190, permissions 200/10/803, disabled account, any
  other error) → `console.error`, which Vercel routes into the error feed for
  Control Tower to escalate.

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
