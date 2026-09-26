# integrations/supabase-management-logs

The **Supabase Management Logs API** feed ([[../specs/error-feed-monitoring]] Phase 2): DB-level errors our own app code never sees — Postgres `ERROR`/`FATAL`/`PANIC`, auth-service errors, edge API 5xxs — polled into the Control Tower "Supabase errors (DB logs)" panel ([[../dashboard/control-tower]]). The app-layer `reportDbError` (Phase 1, [[../libraries/control-tower]]) only catches errors our code holds a `{ error }` for; this pulls the rest straight from Supabase's own logs.

**Poller:** `src/lib/control-tower/supabase-log-poll.ts` · **Cron:** [[../inngest/supabase-log-poll]] (`supabase-log-poll-cron`, every 15 min) · records via `error-feed.ts` → `recordError`, `source='supabase-logs'` into [[../tables/error_events]].

## How it works

1. **The owner pastes a Supabase access token** (personal/management) — the **lone owner setup** of this spec. The service-role key we have is for **data, not logs**; the Logs API needs a real access token. Stored AES-256-GCM encrypted ([[../libraries/crypto]]) in [[../tables/error_feed_supabase_config]] via the owner-only endpoint. Until it exists the poller is a **no-op** and the panel stays green (the Phase 1 app-layer reporter covers what it can).
2. **The cron polls every ~15 min** — for the window `(last_polled_at, now]` (capped to the API's **24h max**), it runs one ClickHouse SQL query per source (Postgres / auth / API) against the unified `logs` endpoint.
3. It **groups every error row by `(source, signature)` client-side** (a burst = one `recordError` with an `occurrences` count), records into [[../tables/error_events]] under `source='supabase-logs'`, and **pages owners on a new signature / spike** (rate-limited to one page per incident per 30 min — same spine as the other feeds).
4. **Advances the cursor** (`last_polled_at = now`) only if at least one source query succeeded — a total failure (e.g. an invalid/expired token) keeps the window so a later poll re-covers it.

## API

- **Endpoint:** `GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs` (the 2026-09-23 replacement for the removed `logs.all` endpoint — [migration changelog](https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint)).
- **Auth:** `Authorization: Bearer <access_token>` (the owner's personal/management token).
- **Query params:** `sql` (a **ClickHouse SQL** query — the new endpoint only accepts ClickHouse dialect), `iso_timestamp_start`, `iso_timestamp_end` (range **≤ 24h**, rounded to the nearest minute).
- **Project ref:** parsed from `NEXT_PUBLIC_SUPABASE_URL` (`https://<ref>.supabase.co`); an explicit `project_ref` in the config overrides it.
- **Response:** `{ result: [...] }` — one object per row, keyed by the SQL `select` aliases.

### The three source queries

Every source now lives in a single unified `logs` table, filtered by the `source` column; nested fields moved from the old `metadata` array (which needed `cross join unnest`) to a flat `log_attributes` map read via `log_attributes['a.b.c']`:

| Source | `where source = ...` | Error filter |
|---|---|---|
| `postgres` | `postgres_logs` | `log_attributes['parsed.error_severity'] in ('ERROR','FATAL','PANIC')` |
| `auth` | `auth_logs` | `log_attributes['level'] in ('error','fatal')` |
| `api` | `edge_logs` | `toInt32OrNull(log_attributes['response.status_code']) >= 500` (Map values are strings — coerce for numeric compare) |

Grouping keyParts (the STABLE bits the signature normalizer keeps — ids/numbers stripped): `["postgres", severity, message]` · `["auth", level, message]` · `["api", status, method, path]`.

## Credentials / env

| What | Where | Who sets it |
|---|---|---|
| Supabase access token | `error_feed_supabase_config.access_token_encrypted` (AES-256-GCM) | owner, one paste via `POST /api/developer/control-tower/supabase-token` |
| `ENCRYPTION_KEY` | env (already set) — encrypts/decrypts the token | platform |
| `NEXT_PUBLIC_SUPABASE_URL` | env (already set) — the project ref source | platform |

## Endpoints (this app)

`POST/GET/DELETE /api/developer/control-tower/supabase-token` — owner-gated. `GET` → `{ configured, projectRef, lastPolledAt }` (**never** the token). `POST { token, projectRef? }` stores it encrypted. `DELETE` clears it (poller → no-op).

## Gotchas

- **Best-effort, never throws** — a per-source query failure is collected into `result.errors` and skipped (the other sources still record); a total failure flips the cron heartbeat `ok:false` (visible as a red tile) but never crashes the cron.
- **The 24h window cap is the API's, not ours** — a poller that's been off >24h will miss the gap older than 24h before now; that's acceptable (the app-layer reporter + Vercel/Inngest feeds cover the live surface).
- **The `logs` endpoint is a Management API endpoint that may change** — Supabase already retired its predecessor (`logs.all`) with two months' notice on 2026-09-23; the queries are isolated in `LOG_QUERIES` for a one-place fix if the ClickHouse schema or endpoint moves again.
- **The token is never returned over the wire** — the owner UI learns only `configured: true/false`.

## Related

[[../specs/error-feed-monitoring]] · [[../inngest/supabase-log-poll]] · [[../tables/error_feed_supabase_config]] · [[../tables/error_events]] · [[../libraries/control-tower]] · [[../integrations/vercel-log-drain]] · [[../inngest/inngest-failure-capture]] · [[../dashboard/control-tower]] · [[../libraries/notify-ops-alert]]
