# db_table_size_history

The [[../libraries/db-health|DB Health Agent]]'s daily per-table size/stat snapshot ([[../specs/db-health-agent]] Phase 1). The box's **daily size sweep** writes **one row per `public` table per sweep** (a batch sharing one `captured_at`) so the agent can compute a **growth rate** — today's size/rows vs the same table ~a day ago — instead of seeing only the current size. The runaway `loop_heartbeats` flood (21.7M rows / 4.5 GB from a 175/sec writer) is the canonical case: a single current reading looks merely "big"; the day-over-day delta is what screams "unbounded, no retention" early.

**Global infra, not workspace-scoped** — the Postgres schema is one shared cluster (same model as [[loop_heartbeats]] / [[error_events]]). RLS: any authenticated user reads (the Control Tower is owner-gated at the route); the service role does all writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `captured_at` | `timestamptz` | the sweep instant — a batch shares ~one value · default `now()` · the day-delta + "latest snapshot" key |
| `table_name` | `text` | the `public` table this row describes |
| `total_bytes` | `bigint` | `pg_total_relation_size` (heap + indexes + TOAST) |
| `table_bytes` | `bigint` | `pg_table_size` (heap + TOAST, no indexes) |
| `index_bytes` | `bigint` | `pg_indexes_size` |
| `row_estimate` | `bigint` | planner `pg_class.reltuples` (cheap, no `count(*)`) |
| `seq_scan` | `bigint` | lifetime seq scans from `pg_stat_user_tables` (the missing-index signal: a high seq-scan share) |
| `idx_scan` | `bigint` | lifetime index scans — the comparison for the seq-scan share |
| `n_live_tup` | `bigint` | live tuples |
| `n_dead_tup` | `bigint` | dead tuples (the bloat ratio = dead / (live+dead)) |
| `last_vacuum` / `last_autovacuum` | `timestamptz?` | manual / auto vacuum times — the autovacuum-lag bloat signal |
| `last_analyze` / `last_autoanalyze` | `timestamptz?` | stats-refresh times |
| `created_at` | `timestamptz` | default `now()` |

## Who writes / reads

- **Writer:** `scripts/builder-worker.ts` `runDbHealthSizeJob` (the daily size sweep) — reads the per-table size + `pg_stat_user_tables` row over the pooler (raw `pg`; not exposed via PostgREST) and inserts the batch with one shared `captured_at`. Service role.
- **Readers:** the same job reads the **prior** day's batch (latest `captured_at` ≥20h back) to compute the day-over-day growth rate (`analyzeGrowth` in [[../libraries/db-health]]), AND **(Phase 2)** a trailing **21-day window** (bounded to the currently-big tables) for the trend projection (`analyzeGrowthTrend` / `analyzeBloatTrend` — least-squares fit → projected days-to-ceiling + a rising-bloat trend); `getDbHealthPanel` reads the **latest** batch's top-N tables by size for the [[../dashboard/control-tower]] DB Health panel.

## Gotchas

- **No retention yet** — Phase 1 writes one batch/day (≈200 rows/day), small. If it ever needs pruning it's exactly the class of finding the agent itself would flag; keep a few weeks for the Phase 2 trend projection ([[../specs/db-health-agent]] Phase 2).
- **`row_estimate` is the planner estimate, not an exact count** — `reltuples` (clamped ≥0). Good enough for a growth rate; never quote it as a precise row count.
- **First sweep produces no growth findings** — there's no prior batch to diff against, so `analyzeGrowth` returns nothing until the second daily run. Honest, not a false "healthy".

## Migration

`supabase/migrations/20260629120000_db_table_size_history.sql` (table + the `(table_name, captured_at desc)` + `(captured_at desc)` indexes + RLS) · apply: `scripts/apply-db-table-size-history-migration.ts`

## Related

[[../libraries/db-health]] · [[../specs/db-health-agent]] · [[loop_heartbeats]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]] · [[../specs/loop-heartbeats-retention]]
