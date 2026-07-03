# usage_wall_events

One row per detected Max/Claude usage wall — stamped with the current window's token burn at the moment the wall hit + the window classification (`5h` session vs `weekly` seven-day). Phase 1 of [[../specs/fleet-usage-cockpit]]. Owner: [[../functions/platform]].

**Discover-the-limit.** Anthropic doesn't publish the hidden Max ceiling. The box detects a wall the instant it sees the 429/wall text (`markAccountCapped` / `markCodexCapped` in `scripts/builder-worker.ts`). At that moment it records ONE row here stamped with the current window's token burn (via [[../libraries/usage-snapshots]] `currentWindowBurn`) — that burn is a LOWER-BOUND estimate of the true limit (you hit the wall AT the limit). `discoverLimit(account, window)` = `MAX(tokens_at_wall)` over this table — it tightens toward the true hidden ceiling as more walls are sampled.

**Claude-only for discovery.** Codex wall events are ALSO recorded (for the wall COUNT / confidence signal), but `discoverLimit` returns `null` for a Codex account — Codex's real limit lives in its `/status %`. The cockpit uses `limit_pct` from [[account_usage_snapshots]] for Codex, not this table.

**Owner-only surface.** RLS: workspace-member `SELECT`, service-role full access. The raw `wall_text` is retained for post-hoc classification / debugging but is never surfaced to a non-owner.

**No customer_id.** CLAUDE.md's rule for customer-referenced tables (add a Sonnet data tool) **does not apply**.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `account` | `text` | NOT NULL · matches [[account_usage_snapshots]].`account` labels — `'Round Robin 1'..'Round Robin 4'` for Max, `'codex'` for Codex |
| `runtime` | `text` | NOT NULL · CHECK `in ('claude','codex')` |
| `window_kind` | `text` | NOT NULL · CHECK `in ('5h','weekly')` — which window the wall belonged to. Classified via `isWeeklyWall(wall_text)` in the worker (`weekly limit`, `seven_day`, `opus_weekly`, `monthly limit`, `thirty_day` → `weekly`; else `5h`). Named `window_kind` (not `window`) — same SQL-keyword avoidance as [[account_usage_snapshots]] |
| `tokens_at_wall` | `bigint` | NOT NULL · default `0` — the token burn recorded for `(account, window)` at the moment the wall hit. `MAX` over this column across sampled walls is the running lower-bound estimate of the true hidden Max limit |
| `wall_text` | `text?` | the raw wall text (429 body / "usage limit reached …"). Retained for classification + debugging; **never** surfaced to a non-owner |
| `wall_reset_at` | `timestamptz?` | the wall's stated reset time (`parseResetTime` on `wall_text`), when parseable |
| `observed_at` | `timestamptz` | NOT NULL · default `now()` — wall-clock the wall was detected |
| `created_at` | `timestamptz` | default `now()` |

**Indexes:** `usage_wall_events_ws_account_idx` on `(workspace_id, account, window_kind, observed_at DESC)` — the read spine for `discoverLimit`. `usage_wall_events_observed_idx` on `observed_at DESC` — freshness ordering.

## Who writes / reads

- **Writer:** `scripts/builder-worker.ts` `recordUsageWallEventBestEffort`, called from `markAccountCapped` (Claude) + `markCodexCapped` (Codex) the first time a cap flips per window. Fire-and-forget — a metering failure must never interfere with cap-handling.
- **Reader (Phase 3):** `GET /api/developer/usage` → [[../libraries/usage-snapshots]] `discoverLimit(account, window)` for each Max account card. Claude shows `burn / discoverLimit`; Codex shows the reported `limit_pct` from [[account_usage_snapshots]] instead.

## Gotchas

- **The discovered limit CONVERGES from below.** `MAX(tokens_at_wall)` starts small (the first wall the box happens to hit at low burn) and tightens toward the true ceiling as more walls are sampled. The cockpit surfaces the wall COUNT alongside the number so the founder watches the confidence grow.
- **`limit=null, wallCount=0` → the cockpit shows `learning…`, not a fabricated %.** Two-currency honesty — never a made-up percentage.
- **Codex rows are recorded but not used for discovery.** Codex's real limit is `/status %`; wall events give the wall COUNT (confidence) only.

## Migration

`supabase/migrations/20260814120000_account_usage_snapshots.sql` (same file as [[account_usage_snapshots]] — one migration, two tables) — apply with `npx tsx scripts/apply-account-usage-snapshots-migration.ts`. Idempotent. RLS enabled with workspace-member `SELECT` + service-role full access.

## Related

[[account_usage_snapshots]] · [[agent_job_costs]] · [[worker_heartbeats]] · [[../libraries/usage-snapshots]] · [[../libraries/fleet-cost]] · [[../specs/fleet-usage-cockpit]] · [[../functions/platform]]
