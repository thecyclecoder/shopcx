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

## Phase 1 — outage-spanning retry + kill the silent swallows (ticket path) ⏳
Bump the ticket handler + analyzer to outage-spanning backoff retries on retryable-dependency errors; convert the swallow-on-!ok Claude calls to throw-and-retry. Brain: [[../inngest/unified-ticket-handler]] · [[../integrations/anthropic]] · [[control-tower]].

## Phase 2 — Claude-down circuit-breaker (park-and-drain) ⏳
A Claude-health breaker driven by the local consecutive-failure counter + the `status.claude.com/api/v2/components.json` poll (Claude API + Claude Code components); parks agent work `blocked_on_dependency` when down + drains on recovery; an "is Claude up?" Control Tower tile; align the autonomous agents. Brain: [[box-multi-account-failover]] · [[../libraries/control-tower]] · [[../integrations/anthropic]].
