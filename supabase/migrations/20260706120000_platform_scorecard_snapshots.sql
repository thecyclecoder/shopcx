-- Platform scorecard snapshot store — the department-level KPI trend table
-- (docs/brain/specs/platform-scorecard-engine.md, Phase 1; milestone (a) Daily pulse of the
-- platform-department-scorecard goal).
--
-- The shared aggregation substrate behind the whole Platform Department Scorecard. Today the data
-- exists (director_activity · agent_jobs · error_events · loop_alerts · approval_decisions + the grade
-- tables) but nothing rolls it up to a department KPI that TRENDS over time. src/lib/agents/
-- platform-scorecard.ts (computePlatformScorecard) computes each KPI over a TRAILING window with a
-- PRIOR-window delta (mirroring the meta scorecards window model — iteration_scorecards_daily) and
-- persists every value HERE so a daily/weekly/monthly tile can chart the curve.
--
-- One row per (workspace_id, metric_key, cadence, snapshot_date). Each row is the as-of value of one
-- KPI for one cadence's trailing window ending at snapshot_date, with the prior equal-length window's
-- value + the % delta for the trend arrow. `detail` carries the per-metric breakdown (e.g. which loops
-- are red, which errors are still-open for MTTR).
--
-- Idempotent upsert key: (workspace_id, metric_key, cadence, snapshot_date) — a same-day re-run
-- UPSERTs in place (no duplicate rows), exactly like iteration_scorecards_daily. The engine in
-- platform-scorecard.ts is the ONLY writer; downstream readers (the scorecard page) read THIS table,
-- never the raw source tables ("read metrics from the scorecard" invariant).
--
-- RLS mirrors director_decision_grades / agent_action_grades (the grade ledgers): any authenticated
-- user SELECTs (the scorecard page is owner-gated above the DB), service role does all writes.
-- See docs/brain/tables/platform_scorecard_snapshots.md.

create table if not exists public.platform_scorecard_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The KPI this row scores, e.g. loop_health | error_backlog | error_mttr_hours | build_throughput |
  -- autonomy_ratio | escalations. Declarative — the per-cadence registry in platform-scorecard.ts seeds
  -- the keys, so a new KPI needs no migration (free text, no CHECK).
  metric_key text not null,
  -- Which cadence's registry produced this row.
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  -- As-of day — the trailing window ends here.
  snapshot_date date not null,
  -- Trailing-window length in days (daily=1, weekly=7, monthly=30/28 …).
  window_days int not null default 1,

  -- The computed metric value over the current window.
  value numeric not null default 0,
  -- The prior equal-length window's value (or the prior stored snapshot for a current-state metric);
  -- null when there's no prior to compare against.
  prior_value numeric,
  -- (value - prior_value) / prior_value — the trend arrow; null when prior_value is null/0.
  delta_pct numeric,
  -- How to render `value`: a raw count, a 0–1 ratio, a duration in hours, or an already-scaled percent.
  unit text not null default 'count' check (unit in ('count', 'ratio', 'hours', 'pct')),
  -- Per-metric breakdown (the red/amber loops, the still-open errors, the numerator/denominator, …).
  detail jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Idempotent grouping key — one row per KPI per cadence per as-of day; a re-run upserts in place.
  constraint platform_scorecard_snapshots_key_uniq
    unique (workspace_id, metric_key, cadence, snapshot_date)
);

-- The read: the scorecard page pulls every KPI for a cadence as-of the latest snapshot_date.
create index if not exists platform_scorecard_snapshots_read_idx
  on public.platform_scorecard_snapshots (workspace_id, cadence, snapshot_date desc);
-- The per-metric trend: chart one KPI's value over time.
create index if not exists platform_scorecard_snapshots_trend_idx
  on public.platform_scorecard_snapshots (workspace_id, metric_key, snapshot_date desc);

alter table public.platform_scorecard_snapshots enable row level security;
drop policy if exists platform_scorecard_snapshots_select on public.platform_scorecard_snapshots;
create policy platform_scorecard_snapshots_select on public.platform_scorecard_snapshots
  for select to authenticated using (auth.uid() is not null);
drop policy if exists platform_scorecard_snapshots_service on public.platform_scorecard_snapshots;
create policy platform_scorecard_snapshots_service on public.platform_scorecard_snapshots
  for all to service_role using (true) with check (true);
