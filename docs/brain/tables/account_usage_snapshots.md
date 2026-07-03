# account_usage_snapshots

Per-account (Max Round Robin 1..4 + Codex) token-burn rollups keyed by `source` (box|mac) + `window` (5h|weekly). Phase 1 of [[../specs/fleet-usage-cockpit]]. Owner: [[../functions/platform]].

The Phase-3 `/dashboard/developer/usage` cockpit SUMs `source='box'` + `source='mac'` per (`account`, `window`) so the founder sees the full picture: the box's own view of its `agent_job_costs` burn PLUS the local ccusage reporter's ~/.claude + ~/.codex/sessions view. Uniquely keyed on `(workspace_id, source, account, window)` so a re-report REPLACES the prior slice — the Mac reporter is idempotent per rollup.

Written by:
- **box** — [[../libraries/usage-snapshots]] `rollupBoxAccountUsage` (called once per heartbeat tick from `scripts/builder-worker.ts` `writeHeartbeat`). Reads [[agent_job_costs]] summed per account over the current 5-hour window and the trailing 7-day week, joins the box's live cap state (`AccountState.cappedUntil` + `codexState` + the weekly-vs-5h classification `isWeeklyWall`) surfaced on [[worker_heartbeats]].`accounts`, and UPSERTs.
- **mac** — Phase 2 `POST /api/developer/usage/report`, owner-authed, wraps [[../recipes/mac-usage-reporter]] `ccusage blocks --json`.

**Two-currency honesty (fleet-cost invariant).** Snapshot rows carry TOKENS + rate-limit proximity — **never** a fabricated `$`. There is no per-token bill on a Max subscription or a ChatGPT plan, so the cockpit's Max/Codex panel shows tokens; the API panel (`ai_token_usage`) shows real `$`. See [[../libraries/fleet-cost]].

**Owner-only surface.** RLS: workspace-member `SELECT`, service-role full access. Writes go through `createAdminClient()` from the API route / worker.

**No customer_id.** CLAUDE.md's rule for customer-referenced tables (add a Sonnet data tool in [[../libraries/sonnet-orchestrator]]) **does not apply**.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `source` | `text` | NOT NULL · CHECK `in ('box','mac')` · WHERE the snapshot was captured — the box's `rollupBoxAccountUsage` writer or the Mac reporter's authed POST |
| `runtime` | `text` | NOT NULL · CHECK `in ('claude','codex')` · which agent runtime the account runs — `claude` = a Max Round Robin lane; `codex` = the ChatGPT-plan device-code login |
| `account` | `text` | NOT NULL · human label for the account. Matches the live [[agent_job_costs]].`account` values: `'Round Robin 1'..'Round Robin 4'` for Max, `'codex'` for Codex |
| `window_kind` | `text` | NOT NULL · CHECK `in ('5h','weekly')` · rolling 5-hour session window OR the trailing 7-day / weekly / opus_weekly wall window. Named `window_kind` (not `window`) — `WINDOW` is a SQL non-reserved keyword that parses ambiguously in `CHECK` clauses |
| `window_start` | `timestamptz?` | wall-clock the window started (or `now - windowLength` for a trailing window). Informational — the unique key is `(workspace, source, account, window)` |
| `window_reset_at` | `timestamptz?` | when the window is scheduled to reset (from the parsed wall message when known, or the account's live `cappedUntil`) |
| `input_tokens` | `integer` | NOT NULL · SUM over [[agent_job_costs]].`input_tokens` for `(account, window)` on `source='box'`; the ccusage per-block total on `source='mac'` |
| `output_tokens` | `integer` | NOT NULL · same shape, `output_tokens` column |
| `cache_creation_tokens` | `integer` | NOT NULL · same shape, `cache_creation_tokens` column |
| `cache_read_tokens` | `integer` | NOT NULL · same shape, `cache_read_tokens` column |
| `capped` | `boolean` | NOT NULL · default `false` · true when the account was capped at capture — `AccountState.cappedUntil > now` / `codexState.cappedUntil > now` (box) or ccusage says the block hit a wall (mac) |
| `capped_until` | `timestamptz?` | the cap's stated reset — mirrors `window_reset_at` for a capped row; NULL when not capped |
| `limit_pct` | `numeric?` | **Codex only** — the reported `/status` percentage (0..100). Claude leaves this NULL — its % comes from `burn / discoverLimit(account, window)` (see [[usage_wall_events]]) |
| `captured_at` | `timestamptz` | NOT NULL · default `now()` · wall-clock the source captured this row (ccusage block end / box rollup tick) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `account_usage_snapshots_touch_updated_at` trigger |

**Unique:** `(workspace_id, source, account, window_kind)` — one snapshot per (workspace, source, account, window). The box's `rollupBoxAccountUsage` tick and the Mac reporter's POST both UPSERT on this key so a re-write REPLACES the prior slice.

**Indexes:** `account_usage_snapshots_ws_idx` on `(workspace_id, account, window_kind)` — the read spine of the cockpit `GET /api/developer/usage`. `account_usage_snapshots_captured_idx` on `captured_at DESC` — freshness ordering.

## Triggers

- `account_usage_snapshots_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Who writes / reads

- **Writer (box):** `scripts/builder-worker.ts` `runAccountUsageRollupBestEffort` → [[../libraries/usage-snapshots]] `rollupBoxAccountUsage`, called each heartbeat tick.
- **Writer (mac, Phase 2):** `POST /api/developer/usage/report` → same table with `source='mac'`.
- **Reader (Phase 3):** `GET /api/developer/usage` → sums `source='box'` + `source='mac'` per `(account, window)` for the cockpit page below Pulse in `src/app/dashboard/sidebar.tsx`.

## Gotchas

- **Tokens, never `$`.** A Max lane / a ChatGPT plan has no per-token bill — this table stores TOKENS + rate-limit proximity only. The `$` column lives in [[ai_token_usage]] and is rendered on the API panel of the cockpit, separately.
- **A Mac re-report REPLACES the prior slice.** The unique key `(workspace_id, source, account, window)` is the upsert spine — the reporter can run every few minutes without accumulating duplicates.
- **A snapshot is a POINT-IN-TIME rollup.** For historical burn charts, aggregate from [[agent_job_costs]] directly (or its rollup in [[../libraries/fleet-cost]]).

## Migration

`supabase/migrations/20260814120000_account_usage_snapshots.sql` — apply with `npx tsx scripts/apply-account-usage-snapshots-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards). RLS enabled with workspace-member `SELECT` + service-role full access.

## Related

[[usage_wall_events]] · [[agent_job_costs]] · [[worker_heartbeats]] · [[ai_token_usage]] · [[../libraries/usage-snapshots]] · [[../libraries/fleet-cost]] · [[../libraries/ai-usage]] · [[../specs/fleet-usage-cockpit]] · [[../functions/platform]] · [[../recipes/mac-usage-reporter]]
