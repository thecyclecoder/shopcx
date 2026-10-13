-- DB Health Agent — per-sweep pg_stat_statements snapshots so rates come from a DELTA, not the
-- months-wide cumulative reset window (docs/brain/specs/db-health-detector-measures-current-rate, Phase 1).
--
-- pg_stat_statements counters are CUMULATIVE since the last stats reset, and Supabase's postgres role
-- can't call pg_stat_reset(). On a long-lived instance that window is MONTHS (1,720h on 2026-10-13), so
-- a cumulative-total / windowHours rate averages a shipped fix across months of pre-fix history and
-- never looks fixed — the detector re-escalates solved problems to the CEO forever. The slow-query
-- sweep now writes one row here each pass (instance totals + per-queryid counters); the request-volume
-- and per-query rates are the DELTA to the snapshot closest to ~24h ago (computeDeltaRateWindow /
-- pickPriorSnapshot in src/lib/control-tower/db-health.ts) — the rate happening NOW.
--
-- Global infrastructure (NOT workspace-scoped) — exactly like db_table_size_history / loop_heartbeats:
-- the Postgres schema is one shared cluster, so a per-workspace column would be meaningless. RLS mirrors
-- db_table_size_history: any authenticated user may read (the Control Tower is owner-gated at the route),
-- service-role writes (the box slow-query sweep).
create table if not exists public.db_stat_statement_snapshots (
  id uuid primary key default gen_random_uuid(),
  -- The snapshot instant (one sweep writes one row).
  captured_at timestamptz not null default now(),
  -- sum(calls) over pg_stat_statements at capture time (cumulative since the last reset).
  total_calls bigint not null default 0,
  -- sum(rows) over pg_stat_statements at capture time (cumulative since the last reset) — the egress proxy.
  total_rows bigint not null default 0,
  -- pg_stat_statements_info.stats_reset at capture time — lets a reader detect a reset between snapshots
  -- (the computeDeltaRateWindow negative-delta fallback) without re-querying.
  stats_reset timestamptz,
  -- Per-queryid counters at capture time: [{ queryid, calls, totalExecTime, rows }, …] — the baseline
  -- the per-query Δ/hr self-clear (analyzeSlowQuery) reads. Bounded to the rows a sweep scanned.
  per_query jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- The delta lookup is "the snapshots closest to 24h ago" — a captured_at scan.
create index if not exists db_stat_statement_snapshots_captured_idx
  on public.db_stat_statement_snapshots (captured_at desc);

alter table public.db_stat_statement_snapshots enable row level security;
drop policy if exists db_stat_statement_snapshots_select on public.db_stat_statement_snapshots;
create policy db_stat_statement_snapshots_select on public.db_stat_statement_snapshots
  for select to authenticated using (auth.uid() is not null);
drop policy if exists db_stat_statement_snapshots_service on public.db_stat_statement_snapshots;
create policy db_stat_statement_snapshots_service on public.db_stat_statement_snapshots
  for all to service_role using (true) with check (true);
