# sol_replay_runs

Audit-trail table for the pre-Sol → Sol shadow-baseline replays authored by [[../recipes/replay-tickets-through-sol|scripts/replay-tickets-through-sol.ts]]. Every run inserts one row; rows are **INSERT-only** so a re-run of the same window produces a fresh row rather than mutating the prior one — the audit trail is preserved. Feeds the `shadow_baseline_cents` field on [[../dashboard/tickets__analytics]] `/api/tickets/analytics/sol-cost`. Phase 4 of [[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]].

The replay itself is a DRY simulation — it NEVER writes [[ticket_directions]], NEVER sends via `stampedSend`, NEVER touches [[ai_token_usage]]. It reads pre-Sol tickets in the window, calls the Direction-writer path in DRY mode (returns the would-be Direction + a Haiku dry token-count on the prompt as `estimated_cents`), then simulates the per-turn cheap loop via [[../libraries/ai-context]] `assembleDirectionContext` + a stubbed `callSonnetOrchestratorV2` that just returns a token count. The output is a per-ticket `{estimated_cents, direction_estimated_cents, per_turn_estimated_cents, turn_count}` blob rolled up into `results` + `total_estimated_cents`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `run_at` | `timestamptz` | — | default `now()` — stamped at insert |
| `sample_size` | `int4` | — | requested sample size (`--sample_size=N` — default 200) |
| `window_start` | `timestamptz` | — | inclusive lower bound of the pre-Sol ticket window |
| `window_end` | `timestamptz` | — | exclusive upper bound of the pre-Sol ticket window |
| `results` | `jsonb` | — | default `'[]'` — array of `{ticket_id, estimated_cents, direction_estimated_cents, per_turn_estimated_cents, turn_count}` — one entry per replayed ticket. `results.length === sample_size` on a fully-completed run. |
| `total_estimated_cents` | `int8` | — | default 0 — sum of `results[*].estimated_cents`; `total_estimated_cents / sample_size` is the mean and the tile also reads `results[*].estimated_cents` for a median. |

**Indexes:**
- `idx_sol_replay_runs_ws_run_at (workspace_id, run_at DESC)` — the "latest replay run" read path used by `/api/tickets/analytics/sol-cost`.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id (ON DELETE CASCADE).

**In:** none — a replay row is a leaf audit artifact.

## Read paths

- `/api/tickets/analytics/sol-cost` — reads the newest row per workspace (`ORDER BY run_at DESC LIMIT 1`) and exposes the median of `results[*].estimated_cents` as `shadow_baseline_cents`; falls back to `total_estimated_cents / sample_size` when `results` is empty. Missing table (pre-migration) → `shadow_baseline_cents: null`.

## Row lifecycle

**INSERT-only.** A replay never updates or deletes a prior row — a re-run with the same window authors a new row so the audit trail is preserved (spec Phase 4 verification).

## RLS

- Service-role: full access (all writes go through `createAdminClient()`).
- Authenticated: SELECT for members of the row's workspace via `workspace_members`.

## Invariants

- **DRY.** The replay reads pre-Sol tickets and simulates cost — it never writes [[ticket_directions]] or [[ticket_messages]] or [[ai_token_usage]]. Verified by counting those tables' rows for each `results[*].ticket_id` before and after the run (no delta).
- **INSERT-only.** No UPDATE path in the script or the SDK. Re-running the same window creates a new row.

## Migration

`supabase/migrations/20260929120001_sol_replay_runs.sql` (apply: `npx tsx scripts/apply-sol-replay-runs-migration.ts`). Idempotent — `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + DO-guarded `CREATE POLICY`.

---

[[../README]] · [[tickets]] · [[ticket_directions]] · [[workspaces]] · [[../dashboard/tickets__analytics]] · [[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]] · [[../functions/cs]] · [[../../CLAUDE]]
