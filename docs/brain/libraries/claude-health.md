# libraries/claude-health

The **Claude-down circuit-breaker** ([[../specs/agent-outage-resilience]] Phase 2). A single persisted signal — "is Claude up?" — readable from BOTH runtimes (Vercel/Inngest + the build box) so the rest of the system can stop hammering a dead API during an outage. The Phase-2 complement to [[anthropic-retry]] (which makes the customer-facing path retry across the outage).

**File:** `src/lib/claude-health.ts` · state: [[../tables/claude_health]] · poll cron: [[../inngest/claude-status-poll-cron]]

## Why

Phase 1 hardened the customer-facing ticket path (retry-don't-drop). But other Claude-dependent work kept failing into the outage: the **repair agent itself 529'd** trying to triage (it needs Claude to run), and the error feed churned N redundant "retry the 5xx" fix proposals on transient outage-window errors. The breaker is the shared "Claude is down — stop dispatching" signal that lets those subsystems **park-and-drain** instead.

## Two signals → one breaker

The breaker is **DOWN (tripped)** when EITHER signal is down:

- **External truth** — the [[../inngest/claude-status-poll-cron]] polls `status.claude.com/api/v2/components.json` every minute and reads the per-component status of **"Claude API (api.anthropic.com)"** + **"Claude Code"**. A `partial_outage`/`major_outage` on either ⇒ external-down. A poll we can't COMPLETE (Statuspage unreachable) does NOT trip it — unreachable ≠ down.
- **Local signal** — N consecutive retryable failures (429/5xx/529/timeout) from our OWN calls (`LOCAL_FAILURE_THRESHOLD = 5`). The immediate signal — trips before the status page catches up. **Auto-expires** (`LOCAL_SIGNAL_TTL_MS = 5 min`): once fresh failures stop, the local trip clears on its own, so there's no hot-path success-reset write (steady-state cost = zero).

## Exports

### `getClaudeHealth(admin?): Promise<ClaudeHealth>`
READ-ONLY live snapshot (recomputes the local-signal TTL + the combined breaker). Best-effort — returns a healthy default (fail OPEN to "Claude is up") on any read error so a breaker hiccup never wrongly parks the system. Drives the Control Tower "is Claude up?" tile via [[control-tower]] (`/api/developer/control-tower`).

### `isClaudeBreakerTripped(admin?): Promise<boolean>`
`getClaudeHealth(...).down`. The consumer convenience — used by [[control-tower]] `error-feed.ts` (suppress the repair fan-out) + the build box (park autonomous jobs).

### `recordClaudeFailure(admin, where?): Promise<void>`
Feed one retryable Claude failure into the local signal (increment + stamp `last_failure_at`, recompute breaker). Best-effort. Wired into the `claude()` helper in [[../inngest/unified-ticket-handler]] (network throw + retryable non-2xx).

### `noteClaudeFailureFromText(admin, text, where?): Promise<boolean>`
Record a local failure only if the text looks like a retryable Claude failure (529/overloaded/timeout/429/5xx/network). Lets a generic catch site feed the signal without classifying. Used by the box worker's `launch()` failure path (a `claude -p` job that 529'd).

### `pollClaudeStatus(): Promise<ClaudeStatusPoll>`
Fetch + parse the Statuspage components feed (8s timeout). Never throws — a failed poll returns `ok:false` + `unknown` statuses.

### `refreshClaudeHealthFromStatus(admin?): Promise<ClaudeHealth>`
Poll + persist the external signal (recompute combined state); housekeeps a stale local counter back to 0 once the API reads `operational`. Called by the poll cron.

### Constants / types
`LOCAL_FAILURE_THRESHOLD` · `LOCAL_SIGNAL_TTL_MS` · `CLAUDE_STATUS_COMPONENTS_URL` · `ClaudeComponentStatus` · `ClaudeHealth`.

## Consumers (park-and-drain)

- [[control-tower]] `error-feed.ts` `recordError` — while tripped: still records the error (tagged `outage_correlated`, grouped under the outage) but does NOT page or enqueue a repair job; a NEW signature is auto-resolved as transient. The genuine fix is Phase 1's retry, not N per-error proposals.
- **build box** (`scripts/builder-worker.ts`) — parks the autonomous agent kinds (`repair`, `storefront-optimizer`, `db_health`, `spec-test`) `blocked_on_dependency` while tripped (`parkClaudeDependentJobs`); drains them on recovery (`requeueBlockedOnDependency`). The box analog of `blocked_on_usage` ([[../specs/box-multi-account-failover]]).
- **Control Tower** — the "is Claude up?" tile + the `claude-status-poll-cron` freshness tile.

## Related

[[anthropic-retry]] · [[../integrations/anthropic]] · [[../tables/claude_health]] · [[../inngest/claude-status-poll-cron]] · [[control-tower]] · [[repair-agent]] · [[../specs/agent-outage-resilience]]
