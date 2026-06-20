-- Storefront Iteration Engine — Phase 5: daily-run records.
--
-- One row per orchestrated daily pipeline run for one Meta ad account: the
-- supervisable-autonomy audit log for the whole engine. Records status, timing,
-- per-stage counts, the active policy version it ran under, and any error — so a
-- human (or the future Growth Director) can see, every day, what the engine did
-- end-to-end (ingest → attribution → rollups → reconcile → 4a actions → 4b
-- recommendations → 6a execution) without reading logs.
--
-- The pipeline STAGES are each idempotent (their own tables upsert on stable
-- keys); this table is append-only run HISTORY — one new row per execution
-- (including retries), so a re-run is observable rather than silently merged.
-- Written by src/lib/meta/iteration-run.ts (`startRun`/`finishRun`), driven by
-- the `meta-iteration-run` Inngest function (daily cron `meta-performance-daily`).
-- Monetary fields are minor units (cents) of the account currency.
-- See docs/brain/specs/storefront-iteration-engine.md (Phase 5).

create table if not exists public.iteration_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,

  -- the scorecard day the run decided on (resolved by the rollups stage; null
  -- if the run failed before scorecards produced a date)
  snapshot_date date,
  -- how the run was kicked off: the daily cron, or a manual/debug trigger
  trigger text not null default 'cron' check (trigger in ('cron', 'manual')),
  -- running  : in flight
  -- complete : finished the full sequence (possibly with stage warnings)
  -- failed   : a stage threw; see `error`
  status text not null default 'running' check (status in ('running', 'complete', 'failed')),

  -- whether an active policy version governed this run (false ⇒ scorecards + 4b
  -- recommendations only, ZERO autonomous actions — the core safety invariant)
  policy_active boolean not null default false,
  policy_version_id uuid references public.iteration_policies(id) on delete set null,

  -- per-stage breadcrumbs: [{ name, status, ms, ...counts }] — agent-legible
  stages jsonb not null default '[]'::jsonb,
  -- run summary: { scorecard_rows, actions_decided, escalations, reversals,
  --               outcomes_reconciled, recommendations, variant_attribution_coverage, ... }
  counts jsonb not null default '{}'::jsonb,

  error text,                                        -- failure message (status='failed')
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,                                   -- finished_at - started_at, stamped on finish

  created_at timestamptz not null default now()
);

create index if not exists iteration_runs_account_started_idx
  on public.iteration_runs (workspace_id, meta_ad_account_id, started_at desc);
create index if not exists iteration_runs_status_idx
  on public.iteration_runs (status, started_at desc);
create index if not exists iteration_runs_snapshot_idx
  on public.iteration_runs (meta_ad_account_id, snapshot_date);

-- ── RLS: members read their workspace; service role full ─────────────────────
alter table public.iteration_runs enable row level security;
drop policy if exists iteration_runs_select on public.iteration_runs;
create policy iteration_runs_select on public.iteration_runs
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists iteration_runs_service on public.iteration_runs;
create policy iteration_runs_service on public.iteration_runs
  for all to service_role using (true) with check (true);
