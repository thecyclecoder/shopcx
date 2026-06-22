-- Storefront slow-loop actual-LTV reconciler — Phase 3 of the storefront LTV-proxy
-- reconciler (docs/brain/specs/storefront-ltv-proxy-reconciler.md, M3).
--
-- The SLOW LOOP + its calibration signal. With monthly renewals, a cohort's TRUE LTV
-- isn't known for ~4 months. Once a cohort's first exposure is that old, the reconciler
-- computes its ACTUAL realized margin-per-visitor (orders/renewals via getCustomerStatsBatch)
-- and compares it to the predicted-LTV proxy recorded at decision time
-- (storefront_ltv_metrics.predicted_ltv_per_visitor_cents). The signed error recalibrates
-- the proxy weights and feeds the M2 lever-importance memory.
--
-- Two tables:
--   storefront_ltv_reconciliations — one row per reconciled cohort (idempotent, ONE-TIME):
--     proxy vs actual + the signed error + the dominant lever class (the M2 recalibration
--     signal read by storefront-lever-memory.applyReconciliationSignal).
--   storefront_ltv_calibration — one row per workspace: the calibrated gate (calibrated_at),
--     the current proxy weights_version, and the recalibration correction (sub_ltv_factor)
--     the fast loop applies. Read by storefront/calibration.getCalibrationState +
--     isConservative — both currently DEFAULT to uncalibrated when the row is absent.
--
-- Safety invariants baked in here:
--   • idempotent: a cohort reconciles exactly once (unique cohort key); a re-run never
--     double-writes nor re-bumps the weights_version.
--   • weights are versioned: every reconciliation stamps the proxy weights_version it judged.
--   • a large proxy-vs-actual error is recorded with escalated=true (surfaced to Growth,
--     not silently absorbed).
-- RLS mirrors storefront_ltv_metrics: workspace-member SELECT, service-role write.

-- ── storefront_ltv_reconciliations ────────────────────────────────────────────
create table if not exists public.storefront_ltv_reconciliations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lander_type text not null,
  audience text not null default 'all',
  -- The decision-time proxy snapshot reconciled (storefront_ltv_metrics.snapshot_date).
  cohort_snapshot_date date not null,
  -- Predicted-LTV proxy recorded at decision time (per exposed visitor, cents).
  proxy_ltv_cents bigint not null default 0,
  -- Actual realized margin per exposed visitor as of reconciliation (~4 months later).
  actual_ltv_cents bigint not null default 0,
  -- Signed relative error = (actual - proxy) / max(proxy, floor).
  --   > 0 → proxy UNDER-predicted (the lever mattered MORE than the proxy thought).
  --   < 0 → proxy OVER-predicted (e.g. discount-heavy subs churned below the estimate).
  error_pct double precision not null default 0,
  -- The proxy weights version the reconciled metric row was computed under (auditable).
  weights_version integer not null default 1,
  -- The dominant lever class of the cohort's experiments — the M2 recalibration signal
  -- (storefront-lever-memory.applyReconciliationSignal keys off lever_key + error_pct). Nullable.
  lever_key text,
  -- Exposed visitors (the proxy denominator) + converting customers sampled for actual LTV.
  visitors integer not null default 0,
  converting_customers integer not null default 0,
  -- The margin fraction applied to realized revenue (placeholder until a real COGS source — flagged).
  margin_fraction double precision not null default 0.6,
  -- True when |error_pct| breached the escalation threshold (surfaced to Growth, not absorbed).
  escalated boolean not null default false,
  -- Honest flags (insufficient_actual_sample, ltv_includes_full_customer_history, …).
  flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The cohort key — idempotent ONE-TIME reconciliation per (cohort × decision-time snapshot).
create unique index if not exists storefront_ltv_reconciliations_cohort_key
  on public.storefront_ltv_reconciliations (workspace_id, product_id, lander_type, audience, cohort_snapshot_date);

-- M2 intake + dashboard read: newest reconciliations per workspace.
create index if not exists storefront_ltv_reconciliations_ws_created_idx
  on public.storefront_ltv_reconciliations (workspace_id, created_at desc);

alter table public.storefront_ltv_reconciliations enable row level security;
drop policy if exists storefront_ltv_reconciliations_select on public.storefront_ltv_reconciliations;
create policy storefront_ltv_reconciliations_select on public.storefront_ltv_reconciliations
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_ltv_reconciliations_service on public.storefront_ltv_reconciliations;
create policy storefront_ltv_reconciliations_service on public.storefront_ltv_reconciliations
  for all to service_role using (true) with check (true);

-- ── storefront_ltv_calibration ────────────────────────────────────────────────
create table if not exists public.storefront_ltv_calibration (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Non-null once the slow loop reconciles at least once — THE calibrated gate. While null
  -- the fast loop reports calibrated=false and the bandit runs conservatively.
  calibrated_at timestamptz,
  -- Current proxy weights version (bumped each recalibration that lands new reconciliations).
  weights_version integer not null default 1,
  -- Recalibration correction multiplier the fast loop applies to est_sub_ltv. 1.0 until the
  -- first reconciliation; < 1 down-weights an over-predicting proxy, > 1 up-weights.
  sub_ltv_factor double precision not null default 1,
  -- Visitor-weighted aggregate signed error across reconciled cohorts at the last recalibration.
  last_error_pct double precision,
  -- Count of distinct cohorts reconciled into the current weights version (audit).
  reconciled_cohorts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One calibration row per workspace — the upsert target.
create unique index if not exists storefront_ltv_calibration_ws_key
  on public.storefront_ltv_calibration (workspace_id);

alter table public.storefront_ltv_calibration enable row level security;
drop policy if exists storefront_ltv_calibration_select on public.storefront_ltv_calibration;
create policy storefront_ltv_calibration_select on public.storefront_ltv_calibration
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_ltv_calibration_service on public.storefront_ltv_calibration;
create policy storefront_ltv_calibration_service on public.storefront_ltv_calibration
  for all to service_role using (true) with check (true);
