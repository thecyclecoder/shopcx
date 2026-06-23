# Agent outage resilience — survive a Claude/API outage queue-driven, never drop work ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens every Claude-dependent agent (customer-facing first); relates to [[box-multi-account-failover]] (the box's version of this). · **Found in use 2026-06-23:** Claude (Code + API) was down ~1 hour. Audit of the **ticket orchestrator** ([[../inngest/unified-ticket-handler]]) shows it's an Inngest fn but `retries: 1` — two attempts with minute-scale backoff can't span an hour, so an in-flight ticket **fails with no AI response and no auto-recovery** when Claude returns. And some calls **swallow the error** (`unified-ticket-handler.ts:173` `if (!r.ok) return ""`) → proceed on empty data instead of retrying. The work isn't queue-durable across an outage.

A real outage must be a **pause, not a drop**: work parks in the queue and drains when the dependency recovers.

## Fix (three layers)
1. **Retry that spans an outage.** Customer-facing Claude-dependent Inngest fns (ticket handler first; analyzer, orchestrator paths) get **many retries with exponential backoff out to hours** (Inngest supports it) — distinguishing a *retryable* dependency failure (Anthropic 429/5xx/overloaded/timeout, network) from a *terminal* logic error (don't infinitely retry a bug). A 1-hour outage → the ticket retries and **completes on recovery**, no human, no drop.
2. **No silent error-swallowing.** A Claude/API call that fails must **throw (→ retry)**, never `return ""`/empty that lets the caller proceed on missing data. Audit `if (!r.ok) return ""` / catch-and-default patterns on LLM/critical calls (start with `unified-ticket-handler.ts:173`); convert to throw-and-retry. (Genuinely-optional enrichment may degrade gracefully, but it must be explicit, not accidental.)
3. **Circuit-breaker: park-and-drain when the dependency is down.** Two health signals: (a) **local** — N consecutive retryable failures (429/5xx/overloaded/timeout) from our own calls = the immediate signal; (b) **external truth** — poll **`https://status.claude.com/api/v2/components.json`** (unauthenticated, Statuspage.io) and read the per-component status of **`Claude API (api.anthropic.com)`** + **`Claude Code`** (`operational`｜`degraded_performance`｜`partial_outage`｜`major_outage`). *(Verified 2026-06-23: this endpoint live-reported the active outage as `major_outage` on both components.)* When DOWN (either signal) → **stop burning retries**: park new agent work (`blocked_on_dependency` / re-enqueue with a delay) and **drain the backlog when the component returns `operational`**, rather than every job hammering a dead API. Mirrors the box's `blocked_on_usage` park-and-resume. Surface the breaker state + the live component status on the Control Tower (an "is Claude up?" tile).

## Scope / priority
- **P1 customer-facing:** the ticket orchestrator + analyzer (a dropped customer ticket is the worst outcome). 
- **Then** the autonomous agents (repair, optimizer, db-health, spec-test) — the box already has multi-account failover; align them to park-and-drain on an all-down condition.
- The box's `claude -p` outage path ([[box-multi-account-failover]]) already parks `blocked_on_usage`; extend that to a *Claude-down* (not just usage-capped) condition.

## Verification
- Simulate Anthropic 5xx/overloaded for a sustained window while a `ticket/inbound-message` is processed → the run **retries with backoff** and **completes on recovery** (the customer gets the response); it does NOT fail-and-drop after 2 attempts.
- A Claude call that gets a non-2xx → it **throws** (run retries), never proceeds on `""`/empty (no silent degradation); `unified-ticket-handler.ts:173`-class swallows are gone.
- With the breaker tripped (Claude down): new ticket/agent work parks (`blocked_on_dependency`) instead of each hammering the API; when Claude recovers, the parked backlog drains automatically — no manual re-queue. The Control Tower shows the breaker state.
- Negative: a terminal logic error still fails fast (not retried for hours); optional-enrichment failures degrade explicitly, not accidentally.

## Phase 1 — outage-spanning retry + kill the silent swallows (ticket path) ✅
Bump the ticket handler + analyzer to outage-spanning backoff retries on retryable-dependency errors; convert the swallow-on-!ok Claude calls to throw-and-retry. Brain: [[../inngest/unified-ticket-handler]] · [[../integrations/anthropic]] · [[control-tower]].

**Shipped:**
- New [[../libraries/anthropic-retry]] — the shared classifier: `AnthropicDependencyError` (retryable 429/5xx/529/timeout/network) vs `NonRetriableError` (terminal 4xx/missing-key), `OUTAGE_SPANNING_RETRIES = 20`, `throwForAnthropicStatus` / `throwForAnthropicNetworkError` / `isRetryableThrownError`.
- [[../inngest/unified-ticket-handler]] `claude()` helper: the `if (!r.ok) return ""` swallow (line 173) and the missing-key `return ""` now **throw** (retryable → retry, terminal → fail fast); network failures throw too. Fn `retries: 1 → OUTAGE_SPANNING_RETRIES`. `personalizeMacroText` is the one explicit `{ optional: true }` enrichment call that still degrades gracefully.
- [[../libraries/sonnet-orchestrator-v2]] `runOrchestratorDecision`: a retryable API-error / network throw now **throws** (so the run retries) instead of degrading every ticket to `fallbackWithCancelRoute("escalate")`. Terminal/parse/max-rounds/no-key still degrade as before.
- [[../libraries/ticket-analyzer]] grader fetch: `return { ok:false, grader_http_* }` swallow → throws. [[../inngest/ticket-analysis-cron]] catches the dependency case and **defers** the ticket (leaves `last_analyzed_at` untouched → re-graded next */30 tick = park-and-drain); `retries: 1 → 3`.

### Verification — Phase 1 (prod-facing)
- On the box, `npx tsc --noEmit` → expect clean (no new errors).
- In Inngest, open the `unified-ticket-handler` fn config → expect **Retries: 20** (was 1). Simulate a sustained Anthropic 5xx/overloaded (e.g. temporarily point `ANTHROPIC_API_KEY` at an overloaded/invalid-5xx proxy) while sending a `ticket/inbound-message` → expect the run to **retry with growing backoff** and **complete on recovery** (customer gets a real response), NOT fail-and-drop after 2 attempts and NOT send an empty/`""` reply.
- Force a Claude **5xx/529** on a quick-turn call (classify-bucket / clarify) → expect the step to **throw** (visible as a retrying step in the Inngest run), never proceed on empty data.
- Force a Claude **terminal 4xx** (e.g. a deliberately malformed request / bad key) → expect the step to **fail fast** (`NonRetriableError`, no hours of retries); the orchestrator path still degrades to a graceful escalation reply.
- On `ticket-analysis-cron`: with Claude returning 5xx, run the cron → expect affected tickets counted as **`deferred`** in the run output and their `last_analyzed_at` **unchanged**; after recovery the next */30 tick **grades them** (`analyzed` increments). A genuine per-ticket logic error still counts as `exception`/`skipped` and is marked so it can't wedge the batch.
- Send a macro reply during a transient Claude blip on `personalizeMacroText` only → expect the **raw macro still sends** (explicit `optional` degrade), not a thrown/parked ticket.

## Phase 2 — Claude-down circuit-breaker (park-and-drain) ⏳
A Claude-health breaker driven by the local consecutive-failure counter + the `status.claude.com/api/v2/components.json` poll (Claude API + Claude Code components); parks agent work `blocked_on_dependency` when down + drains on recovery; an "is Claude up?" Control Tower tile; align the autonomous agents. Brain: [[box-multi-account-failover]] · [[../libraries/control-tower]] · [[../integrations/anthropic]].
