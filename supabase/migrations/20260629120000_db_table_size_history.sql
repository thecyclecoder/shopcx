-- DB Health Agent — daily per-table size/stat snapshots (docs/brain/specs/db-health-agent.md, Phase 1).
--
-- The box's daily size sweep snapshots one row PER public table into this table so the agent can
-- compute a GROWTH RATE (today's total_bytes / row_estimate vs the same table N days ago) instead of
-- only seeing the current size. The runaway loop_heartbeats flood (21.7M rows / 4.5 GB from a 175/sec
-- writer) is the canonical case: a single current-size reading looks merely "big"; the day-over-day
-- delta is what screams "unbounded, no retention" early.
--
-- Global infrastructure (NOT workspace-scoped) — exactly like loop_heartbeats / error_events: the
-- Postgres schema is one shared cluster, so a per-workspace column would be meaningless. RLS mirrors
-- loop_heartbeats: any authenticated user may read (the Control Tower is owner-gated at the route),
-- service-role writes (the box snapshot job).
--
-- The size sweep also captures the scan counters the missing/unused-index detection reads
-- (seq_scan / idx_scan from pg_stat_user_tables) and the bloat signal (dead tuples + last vacuum),
-- so a single daily snapshot row is the full per-table health record for that day.
create table if not exists public.db_table_size_history (
  id uuid primary key default gen_random_uuid(),
  -- The snapshot instant (one sweep writes a batch sharing ~the same captured_at).
  captured_at timestamptz not null default now(),
  -- The public table this row describes.
  table_name text not null,
  -- pg_total_relation_size (heap + indexes + TOAST), in bytes.
  total_bytes bigint not null default 0,
  -- pg_table_size (heap + TOAST, excludes indexes), in bytes.
  table_bytes bigint not null default 0,
  -- pg_indexes_size, in bytes.
  index_bytes bigint not null default 0,
  -- Planner row estimate (pg_class.reltuples) — cheap, no count(*) scan.
  row_estimate bigint not null default 0,
  -- Lifetime scan counters from pg_stat_user_tables (monotonic since last stats reset). The
  -- missing-index signal is a high seq_scan share on a big table; idx_scan is the comparison.
  seq_scan bigint not null default 0,
  idx_scan bigint not null default 0,
  -- Bloat / vacuum-lag signal: live + dead tuples and the last (auto)vacuum/analyze times.
  n_live_tup bigint not null default 0,
  n_dead_tup bigint not null default 0,
  last_vacuum timestamptz,
  last_autovacuum timestamptz,
  last_analyze timestamptz,
  last_autoanalyze timestamptz,
  created_at timestamptz not null default now()
);

-- The growth-rate lookup is "latest snapshot per table" + "this table N days ago" — both ride this.
create index if not exists db_table_size_history_table_captured_idx
  on public.db_table_size_history (table_name, captured_at desc);
-- The panel reads "the most recent sweep, all tables, ordered by size" — a captured_at scan.
create index if not exists db_table_size_history_captured_idx
  on public.db_table_size_history (captured_at desc);

alter table public.db_table_size_history enable row level security;
drop policy if exists db_table_size_history_select on public.db_table_size_history;
create policy db_table_size_history_select on public.db_table_size_history
  for select to authenticated using (auth.uid() is not null);
drop policy if exists db_table_size_history_service on public.db_table_size_history;
create policy db_table_size_history_service on public.db_table_size_history
  for all to service_role using (true) with check (true);
