# error_events

The Control Tower's **error feed** store ([[../specs/error-feed-monitoring]] Phase 1 + Phase 2). One **grouped** incident per distinct error from the "hidden surfaces" the dashboard never showed: **Vercel** runtime errors / 500s, **Inngest** runs that failed after exhausting retries, **app-layer Supabase** errors our own code reported, and (Phase 2) **DB-level Supabase logs** (Postgres/auth/API) pulled from the [[../integrations/supabase-management-logs]] API. A burst of the same error folds into **one row** (`count` bumped, `last_seen_at` refreshed) — not N rows / N pages.

**Global infra, not workspace-scoped** (same as [[loop_heartbeats]] / [[loop_alerts]] / [[worker_heartbeats]]). RLS: any authenticated user reads; service role writes (Inngest + the `/api/webhooks/vercel-logs` endpoint + `reportDbError` from app code).

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `source` | `text` | `'inngest'` ｜ `'vercel'` ｜ `'supabase'` (app-layer reporter) ｜ `'supabase-logs'` (Phase 2 Management-Logs poll) ｜ `'client'` (browser JS errors on storefront + portal, via `/api/client-errors` — [[../specs/client-error-capture]]) · CHECK-constrained — which hidden surface |
| `signature` | `text` | grouping key — a stable hash of the normalized error (uuids/hex/numbers/quoted ids stripped) so the same error recurring lands on the same row. At most **one** row per `(source, signature)` |
| `title` | `text` | short human-readable label for the panel (function id / route + error class) |
| `detail` | `text?` | the fuller / latest message |
| `sample` | `jsonb?` | latest raw sample (function_id, run_id, path, status, code, …) |
| `count` | `int` | total occurrences folded into this incident · default 1 |
| `status` | `text` | `open` (default) ｜ `resolved` · CHECK-constrained (reserved; the dashboard drives panel color off recency, not this) |
| `outage_correlated` | `bool` | **agent-outage-resilience Phase 2** — set when recorded WHILE the Claude-down breaker ([[claude_health]]) was tripped. Such errors are outage symptoms, not new bugs: `recordError` still records them (grouped under the outage) but suppresses paging + the repair fan-out, and a NEW signature is auto-`resolved` as transient. Default `false` |
| `first_seen_at` | `timestamptz` | when this signature first appeared · default `now()` |
| `last_seen_at` | `timestamptz` | bumped every occurrence · default `now()` |
| `last_paged_at` | `timestamptz?` | when we last paged owners — the rate-limit spine (one page per incident per 30 min) |
| `created_at` | `timestamptz` | default `now()` |

## Grouping + paging spine

`error_events_source_signature` — a **unique index** on `(source, signature)`. `recordError()` ([[../libraries/control-tower]] `error-feed.ts`) upserts against it:

- **New signature** (no row) → `insert` (`count = occurrences`, `last_paged_at = now()`) + **page owners** (`notifyOpsAlert` Slack DM to every Slack-connected workspace's owners/admins).
- **Existing** → bump `count += occurrences`, refresh `detail`/`sample`/`last_seen_at`. **Re-page only if `last_paged_at` is older than the 30-min cooldown** — so a burst of the same error = **one page**, while a sustained spike nags once per window.

`recordError` is **best-effort and never throws** — an error-reporter that can crash the path it reports on is worse than the gap it closes. A racing insert (`23505`) falls back to the update path.

**Transient class** (`recordError({ transient: true })` — [[../specs/error-feed-drop-inngest-transport-http-unreachable]]): a noise class non-actionable on a single sighting (an Inngest `http_unreachable` transport reset). A **first sighting** inserts `status='resolved'`, `last_paged_at=null` (recorded + grouped for visibility, **no page, no repair fan-out**); it escalates to a real **open+page** only if the same signature **recurs within 1 h** of the prior sighting (chronic). A prior sighting older than the window is re-resolved as another isolated blip. Sits alongside the outage-window auto-resolve (`outage_correlated`), but keyed on recurrence rather than the Claude breaker.

## Panel color (dashboard)

`buildErrorFeedSnapshot` reads the last 7 days of rows per source and colors each panel by **recency** of the newest occurrence: **red** if any error in the last hour, **amber** if any in the last 24 h, else **green** (healthy → no alert noise). Not driven by `status`.

## Gotchas

- **Signature normalization strips volatile bits** (uuids, long hex, numbers, quoted strings) before hashing — so "row 4821 not found" and "row 9173 not found" collapse to one incident. Group on the STABLE parts (function id / route / error class), never on run-specific ids.
- **Vercel batches are grouped client-side too** — `/api/webhooks/vercel-logs` folds a delivered batch by `(path, status, message)` and calls `recordError` once per group with an `occurrences` count, so a 500-row burst in one POST is one count bump, not 500 reads.
- **The inngest capture skips its own failures** (`function_id === 'inngest-failure-capture'`) — no self-loop.

## Migration

`supabase/migrations/20260622150000_error_events.sql` (this table + RLS) · apply: `scripts/apply-error-events-migration.ts`
`supabase/migrations/20260622160000_supabase_log_poll.sql` (Phase 2: widens the `source` CHECK to admit `'supabase-logs'` + adds [[error_feed_supabase_config]]) · apply: `scripts/apply-supabase-log-poll-migration.ts`
`supabase/migrations/20260622170000_client_error_source.sql` (client-error-capture: widens the `source` CHECK to admit `'client'`) · apply: `scripts/apply-client-error-source-migration.ts`

## Related

[[../specs/error-feed-monitoring]] · [[../libraries/control-tower]] · [[../inngest/inngest-failure-capture]] · [[../integrations/vercel-log-drain]] · [[../integrations/supabase-management-logs]] · [[../inngest/supabase-log-poll]] · [[error_feed_supabase_config]] · [[../dashboard/control-tower]] · [[loop_alerts]] · [[loop_heartbeats]] · [[../libraries/notify-ops-alert]] · [[../libraries/deploy-guardian]] · [[deploy_watches]]
