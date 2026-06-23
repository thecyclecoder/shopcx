# inngest/claude-status-poll-cron

The external-truth half of the Claude-down circuit-breaker ([[../specs/agent-outage-resilience]] Phase 2). Every minute it polls `status.claude.com` and persists the live Claude API + Claude Code component status onto the breaker, so the rest of the system knows when to park-and-drain.

**File:** `src/lib/inngest/claude-status-poll-cron.ts` · logic in [[../libraries/claude-health]]

## Functions

### `claude-status-poll-cron`
- **Trigger:** cron `* * * * *` (every minute)
- **Config:** `retries: 1` (the next tick re-polls in a minute — no value in long retries on a status poll)
- **What it does:** calls `refreshClaudeHealthFromStatus()` — polls `status.claude.com/api/v2/components.json` (unauthenticated Statuspage.io, 8s timeout), reads the per-component status of **"Claude API (api.anthropic.com)"** + **"Claude Code"** (`operational`｜`degraded_performance`｜`partial_outage`｜`major_outage`), and writes them onto the [[../tables/claude_health]] singleton, recomputing the combined breaker (external-down OR the local consecutive-failure signal). Housekeeps a stale local counter back to 0 once the API reads `operational`. A poll it can't COMPLETE (Statuspage unreachable) records `poll_ok:false` but leaves the external signal untouched (unreachable ≠ down).
- **Self-monitoring:** emits a `claude-status-poll-cron` heartbeat at the end (`emitCronHeartbeat`). `ok` = the poll completed; a tripped breaker is a real signal, not a cron failure. Registered in `src/lib/control-tower/registry.ts` (`MONITORED_LOOPS`) so a dead poller shows as a stale cron tile.
- **Returns** `{ api, code, externalDown, localDown, breakerOpen, pollOk }`.

## Downstream events sent

_None._ Side effect is the [[../tables/claude_health]] write. Consumers READ that row: `recordError` ([[../libraries/control-tower]] error-feed) suppresses the repair fan-out while tripped; the build box parks autonomous agent jobs `blocked_on_dependency`; the Control Tower renders the "is Claude up?" tile.

## Tables written

- [[../tables/claude_health]] (the breaker singleton)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Related

[[../libraries/claude-health]] · [[../libraries/anthropic-retry]] · [[../integrations/anthropic]] · [[../specs/agent-outage-resilience]]
