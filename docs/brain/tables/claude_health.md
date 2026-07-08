# claude_health

The **Claude-down circuit-breaker** state ([[../specs/agent-outage-resilience]] Phase 2). A single global **singleton** row (`id = 'singleton'`) holding the breaker's two health signals + derived state, so BOTH runtimes read one source of truth: Vercel/Inngest (the [[../inngest/claude-status-poll-cron]] writes it; `recordError` reads it) and the build box (parks autonomous agent jobs `blocked_on_dependency` when tripped, drains on recovery).

**Global infra, not workspace-scoped** (same as [[loop_heartbeats]] / [[error_events]]). RLS enabled, no policies → only the service-role admin client reads/writes it.

**Primary key:** `id` (text, default `'singleton'`)

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | PK · always `'singleton'` |
| `api_status` | `text` | the "Claude API (api.anthropic.com)" component status — `operational`｜`degraded_performance`｜`partial_outage`｜`major_outage`｜`under_maintenance`｜`unknown` · default `'unknown'` |
| `code_status` | `text` | the "Claude Code" component status (same vocabulary) · default `'unknown'` |
| `external_down` | `bool` | derived: either component in `major_outage`/`under_maintenance` · default `false`. **`partial_outage` does NOT trip it** (CEO decision 2026-07-07) — partial = "degraded but usable", so the box keeps running and the retry layer absorbs the intermittent 529s instead of freezing the whole pipeline. Only a MAJOR outage (or maintenance) parks autonomous jobs. |
| `last_polled_at` | `timestamptz?` | when the status poll last ran |
| `poll_ok` | `bool?` | could we reach Statuspage on the last poll? (`null` = never polled; `false` = unreachable → external signal left untouched) |
| `consecutive_failures` | `int` | the local signal — N consecutive retryable Claude failures from our own calls · default `0` |
| `last_failure_at` | `timestamptz?` | last local failure — the signal auto-expires (`LOCAL_SIGNAL_TTL_MS = 5 min`) if no fresh failure |
| `breaker_open` | `bool` | the tripped state — Claude treated as DOWN (`external_down` OR local-signal-fresh-and-over-threshold) · default `false` |
| `tripped_at` | `timestamptz?` | last false→true transition |
| `recovered_at` | `timestamptz?` | last true→false transition |
| `detail` | `text?` | human-readable one-liner for the Control Tower tile |
| `updated_at` | `timestamptz` | bumped on every write · default `now()` |

## Who writes it

- [[../inngest/claude-status-poll-cron]] → `refreshClaudeHealthFromStatus()` (external signal, every minute).
- [[../libraries/claude-health]] `recordClaudeFailure` / `noteClaudeFailureFromText` (local signal) — fed by the `claude()` helper in [[../inngest/unified-ticket-handler]] (customer-facing retryable failures) + the box worker's `launch()` failure path (a `claude -p` job that 529'd).

All writes recompute `breaker_open` + stamp the transition through one helper so the derived state stays consistent.

## Who reads it

- [[../libraries/claude-health]] `getClaudeHealth` / `isClaudeBreakerTripped` (recomputes the local-signal TTL + breaker live on read).
- [[../libraries/control-tower]] `error-feed.ts` `recordError` — suppress the repair fan-out + tag `error_events.outage_correlated` while tripped.
- `scripts/builder-worker.ts` — park/drain the autonomous agent kinds (`repair`, `storefront-optimizer`, `db_health`, `spec-test`).
- the Control Tower "is Claude up?" tile (`/api/developer/control-tower`).

## Gotchas

- **Fail OPEN:** a read error / missing row returns the healthy default ("Claude is up") — a breaker-read hiccup must never wrongly park the whole system.
- **Unreachable ≠ down:** a poll that can't reach Statuspage records `poll_ok:false` but never trips the external signal.
- **The local signal needs no success-reset:** it auto-expires via the TTL, so the hot customer path only ever WRITES on failure (steady-state cost = zero).

## Related

[[../libraries/claude-health]] · [[../inngest/claude-status-poll-cron]] · [[../libraries/anthropic-retry]] · [[error_events]] · [[../integrations/anthropic]] · [[../specs/agent-outage-resilience]]
