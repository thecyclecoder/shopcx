# `src/lib/agents/agent-jobs-update-retry.ts` — bounded-retry chokepoint for the worker's `agent_jobs` PATCH

The pure retry + error-surface helper the box worker's shared `update(id, patch)` funnels every `agent_jobs` write through ([[../specs/agent-jobs-update-retry-and-error-surface]] Phase 1). Framework-agnostic, no Supabase / worker imports — tests inject a mocked `runOnce` and drive the sequence.

## Why

The Control Tower's Management-Logs feed (signature `supabase-logs:68fda858b6ae7a63`) recorded repeated `521 PATCH /rest/v1/agent_jobs` failures — Cloudflare "Web server is down" served in front of PostgREST. The worker's `update` used to fire and forget the write: no inspection of `{ data, error, status }`, no retry, no surface. A single 521 could silently drop the transition — build stays `running` past terminal, `needs_input` never lands, the dispatch loop proceeds as if the row was updated. The queue lied about what had happened.

## Exports

- `writeAgentJobsUpdateWithRetry(runOnce, opts)` — runs the Supabase update via `runOnce`, retries the transient class with bounded exponential backoff, throws `AgentJobsUpdateError` on exhaustion. Success shape: `{ ok: true, attempts, response }`.
- `AgentJobsUpdateError` — typed failure the helper throws once retries are exhausted; carries `jobId`, `attemptedStatus`, `attempts`, `lastError`, `lastResponse`, `lastThrown`. The dispatch loop MUST propagate this — do not catch-and-continue.
- `isTransientAgentJobsUpdateResponse(resp)` — classifies a returned `{ error, status }` as transient (5xx / 521-shaped message / `fetch failed` in message) vs terminal (`PGRST*` code).
- `isTransientAgentJobsUpdateThrow(err)` — classifies a THROWN error as transient (`fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `socket hang up`) vs terminal (any other throw).

## Retry policy

- **Attempts:** default 4 (initial + 3 retries), clamped to `[1, 8]`.
- **Backoff:** exponential, base 250 ms doubling per attempt — quick enough that a healthy blip clears in < 2 s, bounded enough that a chronic outage surfaces as a typed throw rather than hanging the worker's single-flight lane.
- **Transient class (retry):**
  - Returned `{ error }` with HTTP status 500-599, OR error message containing `521 / 522 / 523 / 524 / bad gateway / gateway time-out / service unavailable / web server is down / fetch failed / network`.
  - Thrown error message matching `fetch failed / network / timeout / socket hang up / ECONNRESET / ETIMEDOUT / EAI_AGAIN / ECONNREFUSED / ENOTFOUND`.
- **Terminal class (fail fast, no retry):**
  - PostgREST error whose `code` starts with `PGRST` (schema / RLS / bad patch bug).
  - Any thrown non-network error (`TypeError`, `SyntaxError`, etc.).

## Callers

- [[builder-worker]] `update(id, patch)` — the shared chokepoint every job kind funnels through. Wraps `db.from("agent_jobs").update({...}).eq("id", id)` in `writeAgentJobsUpdateWithRetry(runOnce, { jobId, attemptedStatus })`.

## Test surface

`src/lib/agents/agent-jobs-update-retry.test.ts` (registered as `npm run test:agent-jobs-update-retry`). Node's built-in test runner, pure `runOnce` mock — no Supabase, no timers. Covers the spec's Verification bullet:

> A mocked 521 is retried and a final failure is surfaced instead of ignored.

Also covers:
- Transient PostgREST classifier (521 / 5xx / null error).
- Terminal `PGRST*` code (fail-fast, no attempts burned).
- Transient thrown network error → retry → success on 2nd attempt.
- Terminal bug-shaped throw → re-thrown as-is (not wrapped).
- First-attempt success returns `{ attempts: 1 }` (no unnecessary retries).

## Related

[[builder-worker]] · [[../specs/agent-jobs-update-retry-and-error-surface]] · [[../tables/agent_jobs]] · [[../operational-rules]]
