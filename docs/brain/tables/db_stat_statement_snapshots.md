# db_stat_statement_snapshots

The [[../libraries/db-health|DB Health Agent]]'s per-sweep `pg_stat_statements` snapshot ([[../specs/db-health-detector-measures-current-rate]] Phase 1). The box's **slow-query sweep** writes **one row per pass** (instance totals + per-queryid counters) so the agent can compute a **current rate from a DELTA** — the counters over the last ~24h — instead of dividing the months-wide cumulative totals by the whole reset window.

**Why it exists:** `pg_stat_statements` counters are CUMULATIVE since the last stats reset, and Supabase's `postgres` role can't call `pg_stat_reset()` (`pg_stat_statements_reset()` is grantable but the window still never zeroes on its own). On a long-lived instance the reset window is MONTHS (1,720h / ~72 days on 2026-10-13), so a `totals / windowHours` rate averaged a shipped fix across months of pre-fix history — the request-volume finding never looked fixed and re-escalated to the CEO forever (the `db-index-*` / `db-reduce-calls-request-volume` / `db-raise-work-mem-instance` cards, all pointing at folded fixes, dismissed 2026-10-13). This table is the baseline the sweep deltas against so the reported rate is the one happening NOW.

**Global infra, not workspace-scoped** — the Postgres schema is one shared cluster (same model as [[db_table_size_history]] / [[loop_heartbeats]] / [[error_events]]). RLS: any authenticated user reads (the Control Tower is owner-gated at the route); the service role does all writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `captured_at` | `timestamptz` | the sweep instant · default `now()` · the "closest to ~24h ago" delta key |
| `total_calls` | `bigint` | `sum(calls)` over `pg_stat_statements` at capture (cumulative since the last reset) |
| `total_rows` | `bigint` | `sum(rows)` shipped to clients at capture (cumulative) — the egress proxy |
| `stats_reset` | `timestamptz?` | `pg_stat_statements_info.stats_reset` at capture — lets a reader detect a reset between snapshots without re-querying |
| `per_query` | `jsonb` | `[{ queryid, calls, totalExecTime, rows }, …]` at capture — the per-query Δ/hr self-clear baseline · default `'[]'` · bounded to the rows a sweep scanned |
| `created_at` | `timestamptz` | default `now()` |

## Who writes / reads

- **Writer:** `scripts/builder-worker.ts` `runDbHealthSlowQueryJob` (the ~hourly slow-query sweep) — after the request-volume pass, reads `sum(calls)`/`sum(rows)` + the scanned rows' per-query counters over the pooler (raw `pg`; not exposed via PostgREST) and inserts one row. Best-effort (a failed insert warns, never breaks the pass). Service role.
- **Readers:** the SAME job's next pass reads the recent snapshots and picks the one closest to ~24h ago (`pickPriorSnapshot` in [[../libraries/db-health]]); `rateFromSnapshotDelta` turns the current totals + that prior into the delta window fed to `analyzeRequestVolume`, and `priorPerQueryFromSnapshot` turns the prior `per_query` into the per-queryid baseline `analyzeSlowQuery` uses for the Δ/hr self-clear.

## Gotchas

- **First sweep has no prior ⇒ labelled reset-window fallback** — with no snapshot older than now, `rateFromSnapshotDelta` returns `source:'reset_window'` over the cumulative totals and the card explicitly says it averages the whole reset window, not the current rate. Honest, not a silent months-wide average.
- **A stats reset between snapshots shows as a negative delta** — the cumulative counter going backwards can only mean a reset, so `rateFromSnapshotDelta` returns `resetDetected:true` + the post-reset totals over the reset window rather than a nonsense negative rate.
- **No retention yet** — one row/pass (~hourly) is small; if it ever needs pruning it's exactly the class the agent itself flags. The delta lookup only reads the most recent ~50 rows.
- **`per_query` only covers the rows a sweep scanned** (top offenders by `total_exec_time`), not every statement — enough for the per-query self-clear, which only needs a baseline for queries that could become findings.

## Migration

`supabase/migrations/20261013120001_db_stat_statement_snapshots.sql` (table + the `(captured_at desc)` index + RLS). No standalone apply-script — applied by the control-tower migration-drift auto-apply ([[../libraries/control-tower/migration-drift]] `applyMergedMigrations`).

## Related

[[../libraries/db-health]] · [[../specs/db-health-detector-measures-current-rate]] · [[db_table_size_history]] · [[loop_heartbeats]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]]
