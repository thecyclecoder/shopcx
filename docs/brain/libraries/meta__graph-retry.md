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

### `classifyAppOwnerActionRequired` — function

```ts
function classifyAppOwnerActionRequired(status: number, error: any): boolean
```
**[[../specs/meta-graph-classify-app-owner-action-required-data-use-check]] Phase 1** — classifies a Graph response as APP_OWNER_ACTION_REQUIRED: a Meta-side gate (canonical example: the yearly "Data Use Checkup") that a HUMAN must clear from the Meta App Dashboard before the API will return data. Fires on HTTP 400 when the concatenated `message` + `error_user_title` + `error_user_message` (lowercased) contains one of Meta's canonical phrasings: "data use checkup", "api access disrupted", or "app is currently unavailable". Distinct from RECONNECT_REQUIRED (the stored user token is dead — App Dashboard has nothing to do; see below), TRANSIENT (retry-able wobble) and PERMANENT (code-change escalation). Retrying an app-owner-action-required error is pointless: the only fix is a human logging into the Meta App Dashboard, so retrying floods logs without possibility of self-heal.

⚠ `"api access blocked"` USED to be a fourth phrasing in this classifier's haystack (added by PR #2369 after the 2026-08-02 Meta incident), but observation showed the remedy for that phrasing is OAuth re-authorization, not an App Dashboard action — it moved to `classifyReconnectRequired` in [[../specs/meta-reconnect-required-class]] Phase 1.

### `classifyReconnectRequired` — function

```ts
function classifyReconnectRequired(status: number, error: any): boolean
```
**[[../specs/meta-reconnect-required-class]] Phase 1** — classifies a Graph response as RECONNECT_REQUIRED: the stored per-workspace user access token has been invalidated by Meta and only OAuth re-consent restores access. The app-level gate is CLEAR — the App Dashboard has nothing left to do. Fires on HTTP 400 when the concatenated `message` + `error_user_title` + `error_user_message` (lowercased) contains `"api access blocked"`. Seed observation: the 2026-08-02 incident, where after the CEO completed the Data Use Checkup Meta switched to this second phrasing on every call made with the stored user token, while the APP token (`{app_id}|{secret}`) still returned 200.

⚠ **TRIGGER, NOT PROOF.** The seed phrasing was observed EXACTLY ONCE across a ~40-minute window. Treat this predicate as a trigger for downstream confirmation — never as sufficient evidence to raise a founder-facing card. [[meta__reconnect-required-escalation]] `escalateReconnectRequired` calls `debug_token` and only raises the card when Meta reports the token as invalid. Do NOT 'simplify' the confirmation away.

### `isAppOwnerActionRequiredError` / `isReconnectRequiredError` / `isHumanBlockedGraphError` — predicates

```ts
function isAppOwnerActionRequiredError(err: unknown): boolean
function isReconnectRequiredError(err: unknown): boolean
function isHumanBlockedGraphError(err: unknown): boolean
```
**[[../specs/meta-reconnect-required-class]] Phase 3** — the SHARED predicates the 5 human-blocked call sites (meta-sync, today-sync, meta-performance, media-buyer-test-cadence, media-buyer-all-customers-refresh) funnel through, replacing copy-pasted `metaClass === "app_owner_action_required"` string comparisons. `isHumanBlockedGraphError` is the true reason for this cluster — a NEW human-blocked class only requires editing THIS one predicate, not touching all five sites. Callers can still branch on the specific class after the human-blocked filter to pick the right escalation SDK.

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

**Phase 1 addition (meta-graph-classify-app-owner-action-required):** when
`classifyAppOwnerActionRequired` fires, `graphError` tags the throw with
`metaClass='app_owner_action_required'` (checked BEFORE permanent so a Data Use
Checkup 400 is never mis-tagged as permanent). See
[[meta__app-owner-action-escalation]] `escalateAppOwnerActionRequired` for the
CEO-card SDK.

**Phase 1 addition (meta-reconnect-required-class):** the `GraphErrorClass`
union was widened to a third member — `reconnect_required` — and when
`classifyReconnectRequired` fires, `graphError` tags the throw with
`metaClass='reconnect_required'`. Ordering in `graphError` is load-bearing:
`classifyAppOwnerActionRequired` FIRST (a Data Use Checkup 400 can never be
downgraded to a reconnect prompt), `classifyReconnectRequired` SECOND,
`isPermanentGraphError` THIRD. All three never retry; each routes to a
different CEO card. See [[meta__reconnect-required-escalation]]
`escalateReconnectRequired` for the CEO-card SDK — which itself confirms
token death via `debug_token` before raising the card.

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

### `registerAppOwnerActionRequiredHandler` — function

```ts
function registerAppOwnerActionRequiredHandler(fn: ((ctx: AppOwnerActionRequiredContext) => void | Promise<void>) | null): void
```
Optional fire-and-forget hook `graphFetchJson` invokes when it classifies a
response as app-owner-action-required. Same pattern as
`registerPermanentGraphErrorHandler`: a module-level slot keeps graph-retry
DB-free. The escalation SDK ([[meta__app-owner-action-escalation]]
`installDefaultAppOwnerActionEscalationHandler`) installs itself here at startup
so any `graphFetchJson` call site reaches the deduped CEO card without knowing
to wrap. Handler throws / rejects are swallowed (a broken escalation must not
mask the underlying app-owner-action-required throw).

### `registerReconnectRequiredHandler` — function

```ts
function registerReconnectRequiredHandler(fn: ((ctx: ReconnectRequiredContext) => void | Promise<void>) | null): void
```
Same shape as the app-owner-action handler — a module-level slot invoked when
`graphFetchJson` classifies a response as `reconnect_required`. The escalation
SDK ([[meta__reconnect-required-escalation]]
`installDefaultReconnectRequiredEscalationHandler`) installs itself here at
startup. The registered handler is expected to CONFIRM token death via
`debug_token` before it books a card; graph-retry itself only carries the
`metaClass='reconnect_required'` tag on the throw. Handler throws / rejects
are swallowed.

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
- **Ordering — app-owner-action-required, then reconnect-required, then permanent, then transient.** The
  `graphError` function classifies in this order: `classifyAppOwnerActionRequired`
  (HTTP 400 with the Data Use Checkup / disrupted / unavailable phrasings),
  `classifyReconnectRequired` (HTTP 400 with `"api access blocked"`),
  `isPermanentGraphError` (HTTP 400 with removed-endpoint wording or
  code/subcode), then transient (is_transient / code 1/2 / 429 / 5xx). Load-bearing:
  a Data Use Checkup 400 can never be downgraded to a reconnect prompt, and a
  reconnect state is never mis-tagged as permanent (code-change escalation).
  All three human-blocked / permanent classes never retry; they route to
  different CEO cards.
- **Reconnect-required is TRIGGER-only in graph-retry.** The `metaClass=
  'reconnect_required'` tag lives here, but graph-retry never decides whether
  a card is raised — that's [[meta__reconnect-required-escalation]]'s
  `debug_token` probe. A single-sighting Meta string oddity therefore cannot
  book a founder-facing card; the probe returning `is_valid=true` is the
  false-positive gate.

---

[[../README]] · [[../../CLAUDE]]
