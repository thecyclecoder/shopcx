-- kpi_audit_log — the per-metric drift trend table written by the
-- `audit-platform-scorecard` step on [[../inngest/platform-director-cron]]
-- (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md Phase 5).
--
-- The standing pass runs `auditAllKpis` for the active workspace and writes
-- ONE row per audited (workspace, metric, cadence) — capturing the persisted
-- snapshot value, the re-derived ground-truth value, the absolute drift, the
-- pct drift, and the `withinTolerance` verdict the kpi-review SDK produced.
--
-- The trend table is what lets the same step open a `loop_alerts` incident on
-- **persistent** drift (≥2 consecutive snapshot dates exceeding tolerance) and
-- self-heal on a one-snapshot blip (transient timing noise — logged but not
-- alerted).
--
-- Workspace-scoped (the KPI engine is workspace-scoped). RLS: any authenticated
-- user reads (so the scorecard surface can chart trend); service role writes.

create table if not exists public.kpi_audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  -- the audited KPI from the [[../libraries/platform-scorecard]] registry.
  metric_key text not null,
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  -- the snapshot_date of the persisted row being audited (NOT now()).
  snapshot_date date not null,
  -- the persisted value from [[../tables/platform_scorecard_snapshots]].
  snapshot_value numeric not null,
  -- the value the same MetricDef.compute produces RIGHT NOW from the raw tables.
  ground_truth_value numeric not null,
  -- `ground_truth_value − snapshot_value` in the metric's native unit.
  drift numeric not null,
  -- `|drift / snapshot_value|`; null when snapshot_value is 0 (divide-by-zero).
  drift_pct numeric,
  -- did the audit verdict from [[../libraries/kpi-review]] consider this row in-tolerance?
  within_tolerance boolean not null,
  -- the metric's unit at audit time (mirrors the snapshot row's unit).
  unit text not null,
  audited_at timestamptz not null default now()
);

-- One audit row per (workspace, metric, cadence, snapshot_date) — the cron
-- runs every 5 min but each (cadence, snapshot_date) tuple maps to ONE
-- platform_scorecard_snapshots row. UPSERT keeps the trend table clean (one
-- verdict per snapshot) and trivially supports the "latest 2 consecutive
-- snapshot_dates" persistence check below.
create unique index if not exists kpi_audit_log_snapshot_unique
  on public.kpi_audit_log (workspace_id, metric_key, cadence, snapshot_date);

-- Trend read pattern: "latest N snapshot_dates per (workspace, metric, cadence)"
-- — used by the cron's persistent-drift check (read the latest 2 snapshot dates
-- per metric and decide whether to open/close a kpi_drift incident).
create index if not exists kpi_audit_log_metric_idx
  on public.kpi_audit_log (workspace_id, metric_key, cadence, snapshot_date desc);

alter table public.kpi_audit_log enable row level security;
drop policy if exists kpi_audit_log_select on public.kpi_audit_log;
create policy kpi_audit_log_select on public.kpi_audit_log
  for select to authenticated using (auth.uid() is not null);
drop policy if exists kpi_audit_log_service on public.kpi_audit_log;
create policy kpi_audit_log_service on public.kpi_audit_log
  for all to service_role using (true) with check (true);
