-- KPI audit trend store + loop_alerts owner/signature columns
-- (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md Phase 5 — audit on the standing pass +
-- alert on persistent drift).
--
-- Two changes shipped together because they're both consumed by the new
-- `audit-platform-scorecard` step on platform-director-cron:
--
--   1) kpi_audit_log — one row per (workspace_id, metric_key, cadence, snapshot_date) recording
--      the persisted snapshot value, the same-window re-derived ground-truth value, the drift, and
--      whether it stayed inside the metric's tolerance band. Trended over time so the alerter can
--      look back ONE row and decide "transient (1 snapshot) vs persistent (≥2 consecutive)" without
--      a window scan. Mirrors the iteration_scorecards_daily idempotent-upsert model — a same-day
--      re-run upserts in place, never a duplicate. Read-only diff layer — the persisted scorecard
--      row is NEVER mutated.
--
--   2) loop_alerts.owner + loop_alerts.signature — the alert-typing pair the platform-director-cron
--      stamps on a `kpi_drift:<metric>:<cadence>` incident so a non-loop alert is filterable by its
--      owning function and a stable de-dupe key beyond `loop_id`. Existing rows leave them NULL
--      (the control-tower monitor never set them); the partial unique index on (loop_id) where
--      status='open' already enforces "one open per signature" when the kpi-drift writer sets
--      loop_id = signature, so no new index is needed.
--
-- See docs/brain/tables/kpi_audit_log.md · docs/brain/tables/loop_alerts.md.

-- ── kpi_audit_log ────────────────────────────────────────────────────────────
create table if not exists public.kpi_audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The KPI this row audits (matches platform_scorecard_snapshots.metric_key — free text, no
  -- CHECK, so a newly-registered KPI needs no migration).
  metric_key text not null,
  -- Which cadence's registry the metric belongs to.
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  -- The as-of day of the snapshot row this audit was diffed against.
  snapshot_date date not null,

  -- The persisted snapshot value (what platform_scorecard_snapshots holds for this key).
  snapshot_value numeric not null default 0,
  -- The re-derived value the same MetricDef.compute produced at audit time.
  ground_truth_value numeric not null default 0,
  -- ground_truth_value − snapshot_value, in the metric's native unit.
  drift numeric not null default 0,
  -- |drift / snapshot_value|; null when snapshot_value = 0 (division undefined).
  drift_pct numeric,
  -- True when drift stayed inside the metric's tolerance band (per-metric override or default 0.5%).
  within_tolerance boolean not null default true,
  -- The tolerance the verdict was judged against — recorded so a tolerance change is auditable
  -- against past readings (we don't have to re-derive the tolerance retrospectively).
  tolerance numeric not null default 0.005,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Idempotent: one row per metric per cadence per snapshot_date — a same-snapshot re-audit
  -- upserts in place, never a duplicate row.
  constraint kpi_audit_log_key_uniq
    unique (workspace_id, metric_key, cadence, snapshot_date)
);

-- The "previous snapshot" lookup: read the most recent row strictly before today's snapshot_date
-- for one (workspace, metric, cadence) to decide transient vs persistent drift.
create index if not exists kpi_audit_log_trend_idx
  on public.kpi_audit_log (workspace_id, metric_key, cadence, snapshot_date desc);

alter table public.kpi_audit_log enable row level security;
drop policy if exists kpi_audit_log_select on public.kpi_audit_log;
create policy kpi_audit_log_select on public.kpi_audit_log
  for select to authenticated using (auth.uid() is not null);
drop policy if exists kpi_audit_log_service on public.kpi_audit_log;
create policy kpi_audit_log_service on public.kpi_audit_log
  for all to service_role using (true) with check (true);

-- ── loop_alerts: owner + signature ───────────────────────────────────────────
alter table public.loop_alerts
  add column if not exists owner text;
alter table public.loop_alerts
  add column if not exists signature text;
