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

- `metaCode === 1` ("unknown, retry later"), `metaCode === 2` ("Service
  temporarily unavailable"), or `metaSubcode === 1504018` ("Your request timed
  out") → `console.warn`. Known-transient Meta-side backend blips that
  [[../libraries/meta__graph-retry]]'s `isTransientGraphError` already retried
  4× with exponential backoff; when the whole retry budget exhausts during a
  Meta-side outage, the next 5-min cron run self-heals, so they must not
  surface as open bugs. See [[../specs/today-sync-quiet-handled-meta-timeout-blips]]
  + [[../specs/today-sync-quiet-all-retry-exhausted-meta-transients]].
- Everything else (auth 190, permissions 200/10/803, disabled account, any
  other error) → `console.error`, which Vercel routes into the error feed for
  Control Tower to escalate.

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
