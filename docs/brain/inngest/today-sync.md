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

## Amazon error handling

The Amazon leg wraps the whole SP-API report lifecycle (request → poll → download
→ process) in a try/catch. The log level is split so the Control Tower error
feed only escalates real problems:

- Caught message contains any of `InternalFailure`, `ServiceUnavailable`,
  `RequestThrottled`, `InternalError`, `TooManyRequests` (case-insensitive), or
  a `Report request failed: ... 5xx` / `Report download failed: 5xx` bare-status
  substring → `console.warn` + `{ amazon: 'transient' }`. Documented AWS
  retry-later codes; the next 5-min cron tick self-heals. Repair signature
  `vercel:de424cf8b0121136`.
- Everything else (auth revoked, disabled connection, permission errors,
  unexpected 4xx, code defects) → `console.error` + `{ amazon: 'error' }`,
  which Vercel routes into the error feed for Control Tower to escalate.

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
  surface as open bugs. See [[../archive.d/today-sync-quiet-all-retry-exhausted-meta-transients]]
  (archived 2026-06-25).
- `httpStatus >= 500` → `console.warn`. Facebook-edge 5xxs (e.g. a 504 gateway
  timeout — Facebook returns HTML with no JSON body, so `metaCode`/`metaSubcode`
  are undefined and only the raw HTTP status distinguishes it from a fatal 400).
  [[../libraries/meta__sync-spend]] now routes through `graphFetchJson`, so an
  edge 504 is retried in-line 4× before this catch even sees it; the surfaced
  error is a genuinely sustained edge blip that the next 5-min cron self-heals.
  Repair signature `vercel:9422061756e527f7`.
- Everything else (auth 190, permissions 200/10/803, disabled account, any
  other error) → `console.error`, which Vercel routes into the error feed for
  Control Tower to escalate.

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
