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

### `isPermanentGraphError` — function

```ts
function isPermanentGraphError(status: number, error: any): boolean
```
**[[../specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]] Phase 2** — classifies a Graph
response as PERMANENT / api-removed: a Meta-side capability we depended on has
been removed. Seed signature is code `100` subcode `2490568` ("ASC campaigns no
longer supported" — the incident that surfaced this class when the CEO went to
crown two Superfood Tabs winners on 2026-07-27 and the mint failed). Also
message-matches `/no longer supported|deprecated|not supported with v\d+/i` on
HTTP 400 (case-insensitive, across `message` + `error_user_title` +
`error_user_msg`) so a future removed surface with a different code/subcode but
Meta's canonical wording still classifies correctly. Distinct from FATAL
(caller-fixable — bad token, wrong permission) and TRANSIENT (retry-able wobble).
Permanent-class errors NEVER retry; retrying only burns quota to reach the
same wall.

### `graphError` — function

```ts
function graphError(status: number, error: any): GraphError
// GraphError = Error & { metaCode?; metaSubcode?; httpStatus?; metaClass? }
```
Builds `meta_<status>: <detail>`, preferring `error_user_title`/`error_user_msg`
over the terse `message`; stamps `metaCode`/`metaSubcode` + `httpStatus` on the
Error. `httpStatus` is the raw HTTP response status — set so callers can
classify Facebook-edge 5xx (e.g. a 504 gateway timeout returns HTML with no JSON
body, so `metaCode`/`metaSubcode` are undefined and only `httpStatus`
distinguishes it from a fatal 400 validation error). [[../inngest/today-sync]]
uses it to demote 5xx retry-exhaustion to `console.warn`.

**Phase 2 addition:** when `isPermanentGraphError` fires, `graphError` tags the
throw with `metaClass='permanent_api_removed'` so a caller catching a Graph
throw can branch on class (a permanent removal deserves a different response
from a bad token). See [[meta__dead-verb-escalation]] `escalateDeadMetaVerb` for
the CEO-card SDK a caller invokes on that branch.

### `registerPermanentGraphErrorHandler` — function

```ts
function registerPermanentGraphErrorHandler(fn: ((ctx: PermanentGraphErrorContext) => void | Promise<void>) | null): void
```
Optional fire-and-forget hook `graphFetchJson` invokes when it classifies a
response as permanent. Kept as a module-level slot so the pure graph-retry
primitive stays DB-free and testable in isolation — the real escalation SDK
([[meta__dead-verb-escalation]] `installDefaultDeadVerbEscalationHandler`)
installs itself here at startup so any `graphFetchJson` call site reaches the
CEO card without knowing to wrap. Handler throws / rejects are swallowed
(a broken escalation must not mask the underlying permanent throw).

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
- **Permanent (api-removed) NEVER retries** — the classifier fires on the FIRST
  attempt and short-circuits the retry loop. The tagged `GraphError.metaClass=
  'permanent_api_removed'` is the caller's contract: catch and branch, don't
  wrap in a generic try/catch that logs "transient wobble". See
  [[meta__dead-verb-escalation]].
- Ordering — permanent classification runs BEFORE transient. A hypothetical
  "no longer supported" message on a 5xx would still classify TRANSIENT
  (retryable) because the permanent branch only fires on HTTP 400, and the
  transient branch owns HTTP 5xx unconditionally.

---

[[../README]] · [[../../CLAUDE]]
