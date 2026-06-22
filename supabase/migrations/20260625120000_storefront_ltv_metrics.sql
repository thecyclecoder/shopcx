-- Storefront predicted-LTV-per-visitor metric — Phase 2 of the storefront LTV-proxy
-- reconciler (docs/brain/specs/storefront-ltv-proxy-reconciler.md, M3).
--
-- One row per (workspace × product × lander_type × audience × snapshot_date): the
-- fast-loop REWARD the M1 bandit decides on. predicted_ltv_per_visitor_cents =
--   ((one_time_conversions × one_time_margin_cents) + (sub_conversions × est_sub_ltv_cents))
--   ÷ visitors
-- computed off the M1 exposure→outcome stream (experiment_exposure + order_placed),
-- with est_sub_ltv_cents from the Phase-1 renewal-derived estimateSubLTV (NOT the flat
-- placeholder the raw attribution proxy uses).
--
-- Safety invariants baked in here:
--   • every row stamps the weights_version it was computed under (auditable, reproducible)
--   • calibrated=false until M3's slow loop reconciles once (conservative-until-calibrated)
--   • idempotent: a daily refresh UPSERTS on the snapshot key, never double-writes
-- RLS mirrors storefront_experiments: workspace-member SELECT, service-role write.

create table if not exists public.storefront_ltv_metrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lander_type text not null,
  audience text not null default 'all',
  -- The cohort snapshot day (UTC). The upsert key — a re-run for the same day overwrites.
  snapshot_date date not null,
  -- Inputs (all off the exposure→outcome stream for this cohort's experiments).
  visitors integer not null default 0,
  one_time_conversions integer not null default 0,
  sub_conversions integer not null default 0,
  -- Phase-1 subAttachRate analogue: sub_conversions ÷ converting sessions, exposure-attributed.
  sub_attach_rate double precision not null default 0,
  -- Phase-1 estimateSubLTV output (renewal-survival × per-renewal margin), product-level.
  est_sub_ltv_cents bigint not null default 0,
  -- Mean MARGIN per one-time conversion (mean one-time order revenue × margin_fraction).
  one_time_margin_cents bigint not null default 0,
  -- The headline REWARD the bandit reads.
  predicted_ltv_per_visitor_cents bigint not null default 0,
  -- The margin fraction applied (placeholder until a real COGS source lands — flagged).
  margin_fraction double precision not null default 0.6,
  -- The proxy weights version this row was computed under (Phase 3 bumps it on recalibration).
  weights_version integer not null default 1,
  -- false until M3's reconciler calibrates once; downstream runs conservatively while false.
  calibrated boolean not null default false,
  -- Realized subscribers sampled for the est_sub_ltv estimate (low-confidence when small).
  est_sub_ltv_sample_size integer not null default 0,
  -- Honest flags echoed from the inputs (cogs_source_missing, audience_not_segmentable, …).
  flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The snapshot key — idempotent upsert target. NOT NULL on every key column so a
-- re-run lands on the same row (NULLs would be treated as distinct).
create unique index if not exists storefront_ltv_metrics_snapshot_key
  on public.storefront_ltv_metrics (workspace_id, product_id, lander_type, audience, snapshot_date);

-- Dashboard read: latest snapshots per workspace cohort (week-over-week surfacing).
create index if not exists storefront_ltv_metrics_ws_date_idx
  on public.storefront_ltv_metrics (workspace_id, snapshot_date desc);

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_experiments) ──
alter table public.storefront_ltv_metrics enable row level security;
drop policy if exists storefront_ltv_metrics_select on public.storefront_ltv_metrics;
create policy storefront_ltv_metrics_select on public.storefront_ltv_metrics
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_ltv_metrics_service on public.storefront_ltv_metrics;
create policy storefront_ltv_metrics_service on public.storefront_ltv_metrics
  for all to service_role using (true) with check (true);
