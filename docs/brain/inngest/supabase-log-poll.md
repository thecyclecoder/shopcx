# inngest/supabase-log-poll

The Supabase Management Logs poller ([[../specs/error-feed-monitoring]] Phase 2). Every ~15 min it pulls DB-level Supabase errors our own app code never sees — Postgres `ERROR`/`FATAL`/`PANIC`, auth-service errors, edge API 5xxs — into the Control Tower error feed, so they page the owners + show on the dashboard instead of being caught by a lucky log dig.

**File:** `src/lib/inngest/supabase-log-poll.ts` · logic in [[../libraries/control-tower]] (`src/lib/control-tower/supabase-log-poll.ts`) · feed integration: [[../integrations/supabase-management-logs]]

## Functions

### `supabase-log-poll-cron`
- **Trigger:** cron `*/15 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** calls `pollSupabaseLogs()` — reads + decrypts the owner's Supabase access token from [[../tables/error_feed_supabase_config]] (a **no-op** if none is set), polls the [[../integrations/supabase-management-logs]] `logs.all` endpoint for the `(last_polled_at, now]` window (capped to 24h) across three sources (Postgres / auth / API), **groups** every error row by `(source, signature)`, and `recordError`s each into [[../tables/error_events]] under `source='supabase-logs'` — paging owners on a new signature / spike (rate-limited, [[../libraries/notify-ops-alert]]). Advances the poll cursor on any partial success.
- **Transient-noise scoping** ([[../specs/error-feed-supabase-logs-transient-5xx-scoping]]): each grouped incident carries a `transient` flag from `isTransientSupabaseLogNoise` (in [[../libraries/control-tower]]'s `error-feed.ts`, the sibling of vercel's `isBareLifecycle` / inngest's `isTransientInngestTransportError`). A **momentary edge API 5xx** (any `500–599`) or a **Postgres `statement timeout` / connection-saturation ERROR** is the collateral of a brief DB-saturation storm that self-heals — so `recordError` auto-resolves a FIRST sighting (recorded for visibility, **no page, no repair fan-out**) and escalates to a real open+page only if the SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS` (1h). A chronic endpoint that 5xxs every poll recurs inside the window → still surfaces. **Never transient** (pages on first sighting): a Postgres `FATAL`/`PANIC`, a non-timeout Postgres ERROR (constraint / data-integrity bug), any auth error, and any non-5xx.
- **Self-monitoring:** emits its own `supabase-log-poll-cron` heartbeat at the end (`emitCronHeartbeat`). `ok:false` only on a **total** query failure (e.g. an invalid token); `no-token` (not yet configured) is healthy. Registered in `src/lib/control-tower/registry.ts` so a dead poller shows as a stale cron tile.
- **Returns** `{ status: 'no-token'|'ok'|'error', incidents, rows, errors }`.

## Downstream events sent

_None._ Side effects are DB writes ([[../tables/error_events]], the [[../tables/error_feed_supabase_config]] cursor) + Slack DMs (via `recordError` → `notifyOpsAlert`).

## Tables written

- [[../tables/error_events]] (grouped incidents, `source='supabase-logs'`)
- [[../tables/error_feed_supabase_config]] (poll cursor `last_polled_at`)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/error_feed_supabase_config]] (the encrypted access token + cursor)
- [[../tables/workspace_members]] (owners/admins to page, inside `recordError`)

## Register-or-it's-incomplete

This cron is in the Control Tower registry (`src/lib/control-tower/registry.ts`, `supabase-log-poll-cron`, 45-min liveness window) + emits a heartbeat — see [[../operational-rules]].

---

[[../README]] · [[../specs/error-feed-monitoring]] · [[../integrations/supabase-management-logs]] · [[../tables/error_events]] · [[../tables/error_feed_supabase_config]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]] · [[../integrations/inngest]]
