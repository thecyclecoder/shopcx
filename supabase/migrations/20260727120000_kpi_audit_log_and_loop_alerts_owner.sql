-- Persistent-drift surveillance for the Platform Department Scorecard
-- (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md, Phase 5 — Audit on the standing pass
-- + alert on persistent drift). Two changes that ship together:
--
--   1. kpi_audit_log — one row per (workspace_id, metric_key, cadence, snapshot_date) per audit
--      run. The standing pass's `audit-platform-scorecard` step writes one row per metric so the
--      ≥2-consecutive-over-tolerance check is queryable from a single bounded read. Without this
--      we'd only have the latest in-memory verdict; persistence is the only honest way to
--      distinguish "transient timing noise" from "the engine is actually wrong."
--
--   2. loop_alerts.owner — a nullable owner column so a `kpi_drift:<metric>:<cadence>` alert
--      (opened by the audit step, not the control-tower-monitor cron) can declare owner='platform'
--      without inheriting the MONITORED_LOOPS-registry derivation that the existing alerts use.
--      Nullable so existing monitor-opened alerts (owner derived from the registry) are
--      unaffected.
--
-- Idempotent: create-if-not-exists + add-column-if-not-exists. Re-runnable.

-- ── kpi_audit_log ────────────────────────────────────────────────────────────
create table if not exists public.kpi_audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  metric_key text not null,
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  -- the snapshot_date of the persisted row that was diffed (the same value the engine wrote).
  snapshot_date date not null,
  -- the persisted snapshot value (what the engine wrote into platform_scorecard_snapshots).
  snapshot_value numeric not null,
  -- the re-derived value the SAME MetricDef.compute produces NOW from the raw tables.
  ground_truth_value numeric not null,
  -- ground_truth − snapshot in the metric's native unit (sign carried so a positive vs negative
  -- drift is greppable; the 2-consecutive check reads abs(drift_pct) instead).
  drift numeric not null,
  -- |drift / snapshot_value|; null when snapshot_value = 0 (division by zero — drift is reported
  -- but the percentage is undefined). Matches KpiAuditReport.driftPct.
  drift_pct numeric,
  -- true when drift_pct ≤ the metric's tolerance (or — when drift_pct is null — when drift = 0).
  -- The trend column the alerter reads: an alert opens iff the last two audits BOTH have
  -- within_tolerance=false.
  within_tolerance boolean not null,
  audited_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- The alerter read: latest 2 audits for (workspace_id, metric_key, cadence). Bounded by the
-- index → no scan.
create index if not exists kpi_audit_log_ws_metric_cadence_idx
  on public.kpi_audit_log (workspace_id, metric_key, cadence, audited_at desc);
-- The trend chart read: per-metric history.
create index if not exists kpi_audit_log_ws_metric_idx
  on public.kpi_audit_log (workspace_id, metric_key, audited_at desc);

alter table public.kpi_audit_log enable row level security;
drop policy if exists kpi_audit_log_select on public.kpi_audit_log;
create policy kpi_audit_log_select on public.kpi_audit_log
  for select to authenticated using (auth.uid() is not null);
drop policy if exists kpi_audit_log_service on public.kpi_audit_log;
create policy kpi_audit_log_service on public.kpi_audit_log
  for all to service_role using (true) with check (true);

-- ── loop_alerts.owner ────────────────────────────────────────────────────────
-- Existing monitor-opened alerts derive their owner from the MONITORED_LOOPS registry (loop_id →
-- registry entry → owner). The audit step opens alerts for loop_ids that aren't in that registry
-- (`kpi_drift:<metric>:<cadence>`), so they need to carry the owner explicitly. Nullable so we
-- don't have to backfill the existing monitor-opened rows.
alter table public.loop_alerts
  add column if not exists owner text;
