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
escalates real problems. The function also installs the app-owner-action-required
escalation handler at the start of the Meta leg and clears the workspace scope
at the end, so a Data Use Checkup / API access disrupted error fires a deduped
CEO card exactly once per workspace per UTC day instead of flooding the Control
Tower feed.

### `isMetaHumanActionBlock(err: unknown): boolean`

Pure classifier exported from today-sync.ts that detects the
"API access disrupted / Data Use Checkup" Meta enforcement signature
(case-insensitive substring match). When an error matches this pattern,
`console.warn` is called with an App Dashboard action pointer
(e.g., `https://developers.facebook.com/apps/`) instead of falling through to the
general transient/error logic. This is a human-blocked enforcement gate,
not a transient — the app owner must complete the checkup in the Meta App Dashboard
before the Graph API will resume; it mirrors the sibling `error-feed-amazon-today-sync-transient`
precedent for the same file, so the Vercel drain stops capturing hundreds of
duplicate Control Tower captures per day while the CEO stays pointed at the exact
human action required. Also exported for unit tests in `today-sync.test.ts`.

### Per-condition log levels

These conditions are evaluated in order after the `isMetaHumanActionBlock` preemption check:

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
- `metaClass === 'app_owner_action_required'` → `console.warn`. Meta-side gate
  a human must clear from the Meta App Dashboard (canonical example: the yearly
  "Data Use Checkup" that disables an app's API access until the workspace owner
  completes it). [[../libraries/meta__graph-retry]]'s `classifyAppOwnerActionRequired`
  tags the error, and [[../libraries/meta__app-owner-action-escalation]]'s
  registered handler raises a deduped CEO card; retrying will never fix this
  class, so the error must not flood the Control Tower feed. Repair signature
  `vercel:7a6fa4c8d1e2b9f4`.
- Everything else (auth 190, permissions 200/10/803, disabled account, any
  other error) → `console.error`, which Vercel routes into the error feed for
  Control Tower to escalate.

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
