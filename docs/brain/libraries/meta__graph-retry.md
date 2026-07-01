# libraries/meta/graph-retry

Shared transient-error retry/backoff wrapper for the Meta Graph **v21.0** clients.
Added by the Iteration Engine ingest-resilience fix: the daily run
([[../inngest/meta-performance]] `meta-iteration-run`) was dying at stage 1
(ingest) on Meta's transient `meta_400: Service temporarily unavailable` (Graph
error code 2) because the v21.0 clients had no retry — and the failure was
self-perpetuating (it re-ran the same heavy backfill every morning and re-failed
identically, DMing owners each time).

**File:** `src/lib/meta/graph-retry.ts`

## Exports

### `graphFetchJson` — function

```ts
async function graphFetchJson(makeRequest: () => Promise<Response>, label: string): Promise<any>
```
Issues the request (the thunk re-runs each attempt so the fetch is fresh), parses
JSON, and retries **transient** failures with bounded exponential backoff +
jitter (4 attempts: ~1s/2s/4s). Returns parsed JSON on success; throws the
canonical `meta_<status>: <detail>` error on a fatal error or once the attempt
budget is exhausted. Transient retries are `console.warn`-logged
(code/subcode/attempt) — "supervisable, not silent."

### `isTransientGraphError` — function

```ts
function isTransientGraphError(status: number, error: any): boolean
```
Transient (retry) = `error.is_transient === true`, Graph `code` 1 ("unknown,
retry later") or 2 ("Service temporarily unavailable" — arrives on an HTTP **400**,
so classify on the Graph code, not the HTTP status), HTTP 429, or HTTP 5xx.
Everything else is fatal.

### `graphError` — function

```ts
function graphError(status: number, error: any): Error & { metaCode?; metaSubcode?; httpStatus? }
```
Builds `meta_<status>: <detail>`, preferring `error_user_title`/`error_user_msg`
over the terse `message`; stamps `metaCode`/`metaSubcode` + `httpStatus` on the
Error. `httpStatus` is the raw HTTP response status — set so callers can
classify Facebook-edge 5xx (e.g. a 504 gateway timeout returns HTML with no JSON
body, so `metaCode`/`metaSubcode` are undefined and only `httpStatus`
distinguishes it from a fatal 400 validation error). [[../inngest/today-sync]]
uses it to demote 5xx retry-exhaustion to `console.warn`.

## Callers

- [[meta__performance]] `graphGet` (insights + structure ingest — the failing path)
- [[meta__sync-spend]] `graphGet` (daily account-level spend rollup)
- [[meta-ads]] `metaGet` / `metaPost`

## Gotchas

- **Fatal errors still fail fast** (190 invalid/expired token, 200/10/803
  permissions, plain 400 validation) — a real misconfiguration surfaces
  immediately, not masked by backoff.
- A genuine **sustained** outage still throws after the attempt budget, so the
  run records `failed` + DMs owners exactly as before — resilience, not silent
  swallowing.
- Does NOT wrap the v18.0 `meta/api.ts` client or the multipart `adimages`
  upload in [[meta-ads]] (FormData body); those are outside the ingest path.

---

[[../README]] · [[../../CLAUDE]]
